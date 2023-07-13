interface AppConfig {
  // Development mode lets you bypass email auth, etc.
  devMode: boolean;
  // The URL of the Passport server.
  passportServer: string;
  // The amount of time a zuzalu qr code proof is valid for
  maxIdentityProofAgeMs: number;
  // whether this is the zuzalu version of the application, or the generic PCDPass
  // TODO: medium-term figure out how to get rid of this/ do this better
  isZuzalu: boolean;
}

export const appConfig: AppConfig = {
  devMode: process.env.NODE_ENV !== "production",
  passportServer: process.env.PASSPORT_SERVER_URL,
  maxIdentityProofAgeMs: 1000 * 60 * 60 * 4,
  isZuzalu: process.env.IS_ZUZALU === "true" ? true : false,
};

console.log("App Config: " + JSON.stringify(appConfig));
