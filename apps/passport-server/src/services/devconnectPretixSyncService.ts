import { Pool } from "pg";
import {
  DevconnectPretixEvent,
  DevconnectPretixEventSettings,
  DevconnectPretixItem,
  DevconnectPretixOrder,
  IDevconnectPretixAPI
} from "../apis/devconnect/devconnectPretixAPI";
import {
  DevconnectPretixConfig,
  DevconnectPretixEventConfig,
  DevconnectPretixOrganizerConfig,
  getDevconnectPretixConfig
} from "../apis/devconnect/organizer";
import { DevconnectPretixTicket, PretixItemInfo } from "../database/models";
import { fetchDevconnectPretixTicketsByEvent } from "../database/queries/devconnect_pretix_tickets/fetchDevconnectPretixTicket";
import { insertDevconnectPretixTicket } from "../database/queries/devconnect_pretix_tickets/insertDevconnectPretixTicket";
import { softDeleteDevconnectPretixTicket } from "../database/queries/devconnect_pretix_tickets/softDeleteDevconnectPretixTicket";
import { updateDevconnectPretixTicket } from "../database/queries/devconnect_pretix_tickets/updateDevconnectPretixTicket";
import {
  fetchPretixEventInfo,
  insertPretixEventsInfo,
  updatePretixEventsInfo
} from "../database/queries/pretixEventInfo";
import {
  deletePretixItemInfo,
  fetchPretixItemsInfoByEvent,
  insertPretixItemsInfo,
  updatePretixItemsInfo
} from "../database/queries/pretixItemInfo";
import { ApplicationContext } from "../types";
import { pretixTicketsDifferent } from "../util/devconnectTicket";
import { logger } from "../util/logger";
import { RollbarService } from "./rollbarService";
import { SemaphoreService } from "./semaphoreService";
import { traced } from "./telemetryService";

const NAME = "Devconnect Pretix";

// Collection of API data for a single event
interface EventData {
  settings: DevconnectPretixEventSettings;
  eventInfo: DevconnectPretixEvent;
  items: DevconnectPretixItem[];
  tickets: DevconnectPretixOrder[];
}

/**
 * Responsible for syncing users from Pretix into an internal representation.
 */
export class DevconnectPretixSyncService {
  private static readonly SYNC_INTERVAL_MS = 1000 * 60;

  private pretixAPI: IDevconnectPretixAPI;
  private pretixConfig: DevconnectPretixConfig;
  private rollbarService: RollbarService | null;
  private semaphoreService: SemaphoreService;
  private db: Pool;
  private timeout: NodeJS.Timeout | undefined;
  private _hasCompletedSyncSinceStarting: boolean;

  public get hasCompletedSyncSinceStarting(): boolean {
    return this._hasCompletedSyncSinceStarting;
  }

  public constructor(
    context: ApplicationContext,
    pretixAPI: IDevconnectPretixAPI,
    pretixConfig: DevconnectPretixConfig,
    rollbarService: RollbarService | null,
    semaphoreService: SemaphoreService
  ) {
    this.db = context.dbPool;
    this.rollbarService = rollbarService;
    this.semaphoreService = semaphoreService;
    this.pretixAPI = pretixAPI;
    this.pretixConfig = pretixConfig;
    this._hasCompletedSyncSinceStarting = false;
  }

  public replaceApi(newAPI: IDevconnectPretixAPI): void {
    const wasRunning = !!this.timeout;

    if (wasRunning) {
      this.stop();
    }

    this.pretixAPI = newAPI;
    this._hasCompletedSyncSinceStarting = false;

    if (wasRunning) {
      this.startSyncLoop();
    }
  }

  public startSyncLoop(): void {
    logger("[DEVCONNECT PRETIX] Starting sync loop");

    const trySync = async (): Promise<void> => {
      await this.trySync();
      this.timeout = setTimeout(
        () => trySync(),
        DevconnectPretixSyncService.SYNC_INTERVAL_MS
      );
    };

    trySync();
  }

  public async trySync(): Promise<void> {
    try {
      logger("[DEVCONNECT PRETIX] Sync start");
      await this.sync();
      await this.semaphoreService.reload();
      this._hasCompletedSyncSinceStarting = true;
      logger("[DEVCONNECT PRETIX] Sync successful");
    } catch (e) {
      this.rollbarService?.reportError(e);
      logger("[DEVCONNECT PRETIX] Sync failed", e);
    }
  }

  public stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  /**
   * Download Pretix state, and apply a diff to our state so that it
   * reflects the state in Pretix.
   */
  private async sync(): Promise<void> {
    return traced(NAME, "sync", async () => {
      const syncStart = Date.now();

      const organizerSyncPromises = []; // one per organizer

      // Iterate over organizers and set up a sync promise for each
      for (const organizer of this.pretixConfig.organizers) {
        organizerSyncPromises.push(this.syncOrganizer(organizer));
      }

      try {
        await Promise.all(organizerSyncPromises);
      } catch (e) {
        logger(
          "[DEVCONNECT PRETIX] Failed to save tickets for one or more events",
          e
        );
        this.rollbarService?.reportError(e);
      }

      const syncEnd = Date.now();

      logger(
        `[DEVCONNECT PRETIX] Sync end. Completed in ${Math.floor(
          (syncEnd - syncStart) / 1000
        )} seconds`
      );
    });
  }

  /**
   * Validate that an event's settings match our expectations.
   * These settings correspond to the "Ask for email addresses per ticket"
   * setting in the Pretix UI being set to "Ask and require input", which
   * is mandatory for us.
   */
  private validateEventSettings(
    settings: DevconnectPretixEventSettings
  ): boolean {
    if (
      settings.attendee_emails_asked === true &&
      settings.attendee_emails_required === true
    ) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Validate that an item/products settings match our expectations.
   * These settings correspond to the product being of type "Admission",
   * "Personalization" being set to "Personalized ticket", and
   * "Generate tickets" in the "Tickets & Badges" section being set to
   * "Choose automatically depending on event settings" in the Pretix UI.
   */
  private validateEventItem(item: DevconnectPretixItem): boolean {
    if (
      item.admission === true &&
      item.personalized === true &&
      (item.generate_tickets === null || item.generate_tickets === undefined)
    ) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Check all of the API responses for an event before syncing them to the
   * DB.
   */
  private checkEventData(
    eventData: EventData,
    eventConfig: DevconnectPretixEventConfig
  ): void {
    const { settings, items } = eventData;
    const activeItemIdSet = new Set(eventConfig.activeItemIDs);

    // We want to make sure that we log all errors, so we collect everything
    // and only throw an exception once we have found all of them.
    const errors = [];

    if (!this.validateEventSettings(settings)) {
      errors.push(
        `Event settings for "${eventData.eventInfo.name}" (${eventData.eventInfo.slug}) are invalid`
      );
    }

    for (const item of items) {
      // Ignore items which are not in the events "activeItemIDs" set
      if (
        activeItemIdSet.has(item.id.toString()) &&
        !this.validateEventItem(item)
      ) {
        errors.push(`Event item "${item.name.en}" (${item.id}) is invalid`);
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
  }

  /**
   * Fetch all of the API responses necessary to sync an event, so that we
   * can inspect them before beginning a sync.
   */
  private async fetchEventData(
    organizer: DevconnectPretixOrganizerConfig,
    event: DevconnectPretixEventConfig
  ): Promise<EventData> {
    return traced(NAME, "fetchEventData", async () => {
      const { orgURL, token } = organizer;
      const { eventID } = event;

      const settings = await this.pretixAPI.fetchEventSettings(
        orgURL,
        token,
        eventID
      );

      const items = await this.pretixAPI.fetchItems(orgURL, token, eventID);

      const eventInfo = await this.pretixAPI.fetchEvent(orgURL, token, eventID);

      const tickets = await this.pretixAPI.fetchOrders(orgURL, token, eventID);

      return { settings, items, eventInfo, tickets };
    });
  }

  /**
   * Sync an organizer's events. This process should abort if any invalid
   * data is found in the event's API responses.
   */
  private async syncOrganizer(
    organizer: DevconnectPretixOrganizerConfig
  ): Promise<PromiseSettledResult<void>[] | undefined> {
    return traced(NAME, "syncOrganizer", async () => {
      logger(`[DEVCONNECT PRETIX] Syncing Pretix for ${organizer.orgURL}`);
      try {
        const eventSyncPromises = [];

        for (const event of organizer.events) {
          const eventData = await this.fetchEventData(organizer, event);
          // Will throw an exception if event data is invalid, aborting
          // sync for this organizer.
          this.checkEventData(eventData, event);

          eventSyncPromises.push(this.syncEvent(organizer, event, eventData));
        }

        // Return a promise which resolves when all events are sync'ed.
        return Promise.allSettled(eventSyncPromises);
      } catch (e) {
        logger(
          `[DEVCONNECT PRETIX] Sync aborted for organizer ${organizer.id} due to errors`,
          e
        );
        this.rollbarService?.reportError(e);
      }
    });
  }

  /**
   * Sync a single event.
   */
  private async syncEvent(
    organizer: DevconnectPretixOrganizerConfig,
    event: DevconnectPretixEventConfig,
    eventData: EventData
  ): Promise<void> {
    try {
      const { eventInfo, items, tickets } = eventData;

      if (!(await this.syncEventInfos(organizer, event, eventInfo))) {
        logger(
          `[DEVCONNECT PRETIX] Aborting sync due to error in updating event info`
        );
        return;
      }

      if (!(await this.syncItemInfos(organizer, event, items))) {
        logger(
          `[DEVCONNECT PRETIX] Aborting sync due to error in updating item info`
        );
        return;
      }

      if (!(await this.syncTickets(organizer, event, tickets))) {
        logger(`[DEVCONNECT PRETIX] Error updating tickets`);
        return;
      }
    } catch (e) {
      logger("[DEVCONNECT PRETIX] Sync aborted due to errors", e);
      this.rollbarService?.reportError(e);
    }
  }

  /**
   * Sync, and update data for Pretix event.
   * Returns whether update was successful.
   */
  private async syncEventInfos(
    organizer: DevconnectPretixOrganizerConfig,
    event: DevconnectPretixEventConfig,
    eventInfo: DevconnectPretixEvent
  ): Promise<boolean> {
    return traced(NAME, "syncEventInfos", async (span) => {
      const { orgURL } = organizer;
      const { eventID, id: eventConfigID } = event;

      try {
        const {
          name: { en: eventNameFromAPI }
        } = eventInfo;
        const existingEvent = await fetchPretixEventInfo(
          this.db,
          eventConfigID
        );
        if (!existingEvent) {
          await insertPretixEventsInfo(
            this.db,
            eventNameFromAPI,
            eventConfigID
          );
        } else {
          await updatePretixEventsInfo(
            this.db,
            existingEvent.id,
            eventNameFromAPI
          );
        }
      } catch (e) {
        logger(
          `[DEVCONNECT PRETIX] Error while syncing event for ${orgURL} and ${eventID}, skipping update`,
          { error: e }
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Sync, check, and update data for Pretix active items under event.
   * Returns whether update was successful.
   */
  private async syncItemInfos(
    organizer: DevconnectPretixOrganizerConfig,
    event: DevconnectPretixEventConfig,
    itemsFromAPI: DevconnectPretixItem[]
  ): Promise<boolean> {
    return traced(NAME, "syncItemInfos", async (span) => {
      const { orgURL, token } = organizer;
      const { eventID, activeItemIDs, id: eventConfigID } = event;

      try {
        const eventInfo = await fetchPretixEventInfo(this.db, eventConfigID);

        if (!eventInfo) {
          throw new Error(
            `Couldn't find an event info matching event config id ${eventConfigID}`
          );
        }

        const newItemIDsSet = new Set(itemsFromAPI.map((i) => i.id.toString()));
        const activeItemIDsSet = new Set(activeItemIDs);
        // Ensure all configured "active items" exist under the Pretix event's returned items.
        // If any do not exist under active items, log an error and stop syncing.
        if (activeItemIDs.some((i) => !newItemIDsSet.has(i))) {
          throw new Error(
            `One or more of event's active items no longer exist on Pretix.\n` +
              `old event set: ${activeItemIDs.join(",")}\n` +
              `new event set: ${Array.from(newItemIDsSet).join(",")}\n`
          );
        }
        const newActiveItems = itemsFromAPI.filter((i) =>
          activeItemIDsSet.has(i.id.toString())
        );

        const newActiveItemsByItemID = new Map(
          newActiveItems.map((i) => [i.id.toString(), i])
        );
        const existingItemsInfo = await fetchPretixItemsInfoByEvent(
          this.db,
          eventInfo.id
        );
        const existingItemsInfoByItemID = new Map(
          existingItemsInfo.map((i) => [i.item_id, i])
        );
        const itemsToInsert = newActiveItems.filter(
          (i) => !existingItemsInfoByItemID.has(i.id.toString())
        );

        // Step 1 of saving: insert items that are new
        logger(
          `[DEVCONNECT PRETIX] [${organizer.orgURL}::${eventInfo.event_name}] Inserting ${itemsToInsert.length} item infos`
        );
        for (const item of itemsToInsert) {
          logger(
            `[DEVCONNECT PRETIX] [${organizer.orgURL}::${
              eventInfo.event_name
            }] Inserting item info ${JSON.stringify(item)}`
          );
          await insertPretixItemsInfo(
            this.db,
            item.id.toString(),
            eventInfo.id,
            item.name.en
          );
        }

        // Step 2 of saving: update items that have changed
        // Filter to items that existed before, and filter to those that have changed.
        const itemsToUpdate = newActiveItems
          .filter((i) => existingItemsInfoByItemID.has(i.id.toString()))
          .filter((i) => {
            const oldItem = existingItemsInfoByItemID.get(i.id.toString())!;
            return oldItem.item_name !== i.name.en;
          });

        // For the active item that have changed, update them in the database.
        logger(
          `[DEVCONNECT PRETIX] [${organizer.orgURL}::${eventInfo.event_name}] Updating ${itemsToUpdate.length} item infos`
        );
        for (const item of itemsToUpdate) {
          const oldItem = existingItemsInfoByItemID.get(item.id.toString())!;
          logger(
            `[DEVCONNECT PRETIX] [${organizer.orgURL}::${
              eventInfo.event_name
            }] Updating item info ${JSON.stringify(
              oldItem
            )} to ${JSON.stringify({ ...oldItem, item_name: item.name.en })}`
          );
          await updatePretixItemsInfo(this.db, oldItem.id, item.name.en);
        }

        // Step 3 of saving: remove items that are not active anymore
        const itemsToRemove = existingItemsInfo.filter(
          (existing) => !newActiveItemsByItemID.has(existing.item_id)
        );
        logger(
          `[DEVCONNECT PRETIX] [${organizer.orgURL}::${eventInfo.event_name}]  Deleting ${itemsToRemove.length} item infos`
        );
        for (const item of itemsToRemove) {
          logger(
            `[DEVCONNECT PRETIX] [${organizer.orgURL}::${
              eventInfo.event_name
            }] Deleting item info ${JSON.stringify(item)}`
          );
          await deletePretixItemInfo(this.db, item.id);
        }
      } catch (e) {
        logger(
          `[DEVCONNECT PRETIX] Error while syncing items for ${orgURL} and ${eventID}, skipping update`,
          { error: e }
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Sync and update data for Pretix tickets under event.
   * Returns whether update was successful.
   */
  private async syncTickets(
    organizer: DevconnectPretixOrganizerConfig,
    event: DevconnectPretixEventConfig,
    pretixOrders: DevconnectPretixOrder[]
  ): Promise<boolean> {
    return traced(NAME, "syncTickets", async (span) => {
      const { orgURL } = organizer;
      const { eventID, id: eventConfigID } = event;

      try {
        const eventInfo = await fetchPretixEventInfo(this.db, eventConfigID);

        if (!eventInfo) {
          throw new Error(
            `Couldn't find an event info matching event config id ${eventConfigID}`
          );
        }

        // Fetch updated version after DB updates
        const updatedItemsInfo = await fetchPretixItemsInfoByEvent(
          this.db,
          eventInfo.id
        );

        const ticketsFromPretix = this.ordersToDevconnectTickets(
          pretixOrders,
          updatedItemsInfo
        );

        const newTicketsByPositionId = new Map(
          ticketsFromPretix.map((t) => [t.position_id, t])
        );
        const existingTickets = await fetchDevconnectPretixTicketsByEvent(
          this.db,
          eventConfigID
        );
        const existingTicketsByPositionId = new Map(
          existingTickets.map((t) => [t.position_id, t])
        );
        const newTickets = ticketsFromPretix.filter(
          (t) => !existingTicketsByPositionId.has(t.position_id)
        );

        // Step 1 of saving: insert tickets that are new
        logger(
          `[DEVCONNECT PRETIX] [${organizer.orgURL}::${eventInfo.event_name}] Inserting ${newTickets.length} new tickets`
        );
        for (const ticket of newTickets) {
          logger(
            `[DEVCONNECT PRETIX] [${organizer.orgURL}::${
              eventInfo.event_name
            }] Inserting ticket ${JSON.stringify(ticket)}`
          );
          await insertDevconnectPretixTicket(this.db, ticket);
        }

        // Step 2 of saving: update tickets that have changed
        // Filter to tickets that existed before, and filter to those that have changed.
        const updatedTickets = ticketsFromPretix
          .filter((t) => existingTicketsByPositionId.has(t.position_id))
          .filter((t) => {
            const oldTicket = existingTicketsByPositionId.get(t.position_id)!;
            const newTicket = t;
            return pretixTicketsDifferent(oldTicket, newTicket);
          });

        // For the tickets that have changed, update them in the database.
        logger(
          `[DEVCONNECT PRETIX] [${organizer.orgURL}::${eventInfo.event_name}] Updating ${updatedTickets.length} tickets`
        );
        for (const updatedTicket of updatedTickets) {
          const oldTicket = existingTicketsByPositionId.get(
            updatedTicket.position_id
          );
          logger(
            `[DEVCONNECT PRETIX] [${organizer.orgURL}::${
              eventInfo.event_name
            }] Updating ticket ${JSON.stringify(oldTicket)} to ${JSON.stringify(
              updatedTicket
            )}`
          );
          await updateDevconnectPretixTicket(this.db, updatedTicket);
        }

        // Step 3 of saving: soft delete tickets that don't exist anymore
        const removedTickets = existingTickets.filter(
          (existing) => !newTicketsByPositionId.has(existing.position_id)
        );
        logger(
          `[DEVCONNECT PRETIX] [${organizer.orgURL}::${eventInfo.event_name}] Deleting ${removedTickets.length} tickets`
        );
        for (const removedTicket of removedTickets) {
          logger(
            `[DEVCONNECT PRETIX] [${organizer.orgURL}::${
              eventInfo.event_name
            }] Deleting ticket ${JSON.stringify(removedTicket)}`
          );
          await softDeleteDevconnectPretixTicket(this.db, removedTicket);
        }

        span?.setAttribute("ticketsInserted", newTickets.length);
        span?.setAttribute("ticketsUpdated", updatedTickets.length);
        span?.setAttribute("ticketsDeleted", removedTickets.length);
        span?.setAttribute(
          "ticketsTotal",
          existingTickets.length + newTickets.length - removedTickets.length
        );
      } catch (e) {
        logger(
          `[DEVCONNECT PRETIX] error while syncing for ${orgURL} and ${eventID}, skipping update`,
          { error: e }
        );
        return false;
      }
      return true;
    });
  }

  /**
   * Converts a given list of orders to tickets, and sets
   * all of their roles to equal the given role. When `subEvents`
   * is passed in as a parameter, cross-reference them with the
   * orders, and set the visitor date ranges for the new
   * `DevconnectPretixTicket` to equal to the date ranges of the visitor
   * subevent events they have in their order.
   */
  private ordersToDevconnectTickets(
    orders: DevconnectPretixOrder[],
    itemsInfo: PretixItemInfo[]
  ): DevconnectPretixTicket[] {
    // Go through all orders and aggregate all item IDs under
    // the same (email, event_id, organizer_url) tuple. Since we're
    // already fixing the event_id and organizer_url in this function,
    // we just need to have the email as the key for this map.
    const itemsInfoByItemID = new Map(itemsInfo.map((i) => [i.item_id, i]));
    const tickets: DevconnectPretixTicket[] = [];
    for (const order of orders) {
      // check that they paid
      if (order.status !== "p") {
        continue;
      }
      for (const {
        id,
        positionid,
        item,
        attendee_name,
        attendee_email,
        secret
      } of order.positions) {
        const existingItem = itemsInfoByItemID.get(item.toString());
        if (existingItem) {
          // Try getting email from response to question; otherwise, default to email of purchaser
          if (!attendee_email) {
            logger(
              `[DEVCONNECT PRETIX] Encountered order position without attendee email, defaulting to order email`,
              JSON.stringify({
                orderCode: order.code,
                positionID: positionid,
                orderEmail: order.email
              })
            );
          }
          const email = (attendee_email || order.email).toLowerCase();

          tickets.push({
            email,
            full_name: attendee_name,
            devconnect_pretix_items_info_id: existingItem.id,
            is_deleted: false,
            is_consumed: false,
            position_id: id.toString(),
            secret
          });
        }
      }
    }
    return tickets;
  }
}

/**
 * Kick off a period sync from Pretix into PCDPassport
 */
export async function startDevconnectPretixSyncService(
  context: ApplicationContext,
  rollbarService: RollbarService | null,
  semaphoreService: SemaphoreService,
  devconnectPretixAPI: IDevconnectPretixAPI | null
): Promise<DevconnectPretixSyncService | null> {
  if (context.isZuzalu) {
    logger("[DEVCONNECT PRETIX] Not starting service because IS_ZUZALU=true");
    return null;
  }

  if (!devconnectPretixAPI) {
    logger(
      "[DEVCONNECT PRETIX] Can't start sync service - no api instantiated"
    );
    return null;
  }

  const devconnectPretixConfig = await getDevconnectPretixConfig(
    context.dbPool
  );

  if (!devconnectPretixConfig) {
    return null;
  }

  const pretixSyncService = new DevconnectPretixSyncService(
    context,
    devconnectPretixAPI,
    devconnectPretixConfig,
    rollbarService,
    semaphoreService
  );

  pretixSyncService.startSyncLoop();
  return pretixSyncService;
}
