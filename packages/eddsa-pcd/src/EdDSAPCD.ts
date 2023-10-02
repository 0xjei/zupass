import {
  DisplayOptions,
  PCD,
  PCDPackage,
  SerializedPCD,
  StringArgument,
  StringArrayArgument
} from "@pcd/pcd-types";
import { fromHexString, toHexString, requireDefinedParameter } from "@pcd/util";
import { buildEddsa, buildPoseidon, Eddsa, Point, Poseidon } from "circomlibjs";
import { v4 as uuid } from "uuid";
import { EdDSACardBody } from "./CardBody";

/**
 * The representation of an EdDSA public key as a pair of points (hexadecimal strings)
 * on the elliptic curve.
 */
export type EDdSAPublicKey = [string, string];

/** The globally-unique representation of the specific type of the PCD. */
export const EdDSAPCDTypeName = "eddsa-pcd";

/** This interface defines the arguments required to initialize a PCD. */
export interface EdDSAInitArgs {}

/**
 * This interface defines the arguments to make a new EdDSA PCD. The goal is 
 * to demonstrate that a certain EdDSA keypair is known by signing 
 * an array of messages using the correspondent private key.
 */
export interface EdDSAPCDArgs {
  /**
   * Any 32-bytes EdDSA private key (32-bytes hexadecimal string) for signing the message.
   * Use {@link newEdDSAPrivateKey} to generate a new one securely.
   */
  privateKey: StringArgument;
  
  /**
   * An array of contents to be signed with the private key. 
   * The message is represented as a string version of a set of BigInts signing object.
   */
  message: StringArrayArgument;
 
  /**
   * The unique identifier of the PCD.
   */
  id: StringArgument;
}

/**
 * This interface defines the EdDSA PCD claim. The claim contains a message signed 
 * with the private key corresponding to the given public key.
 */
export interface EdDSAPCDClaim {
  /**
   * An EdDSA public key corresponding to the EdDSA private key used 
   * for signing the message.
   */
  publicKey: EDdSAPublicKey;
  
  /** An array of signed contents (BigInts) with the corresponding private key. */
  message: Array<bigint>;
}

/**
 * This interface defines the EdDSA PCD proof. The proof is the signature which proves 
 * that the private key corresponding to the public key in the claim, has been successfully 
 * used to sign the message.
 */
export interface EdDSAPCDProof {
  /**
   * The EdDSA signature of the message as hexadecimal string.
   */
  signature: string;
}

/**
 * Create a new EdDSA PCD from an {@link EdDSAPCDClaim} and {@link EdDSAPCDProof}.
 */
export class EdDSAPCD implements PCD<EdDSAPCDClaim, EdDSAPCDProof> {
  public type = EdDSAPCDTypeName;

  public id: string;
  public claim: EdDSAPCDClaim;
  public proof: EdDSAPCDProof;

  public constructor(id: string, claim: EdDSAPCDClaim, proof: EdDSAPCDProof) {
    this.id = id;
    this.claim = claim;
    this.proof = proof;
  }
}

/** 
 * This variable is a placeholder to check whether the {@link Eddsa} and {@link Poseidon} classes 
 * have been properly initialized from external library.
 * 
 * @see {@link https://github.com/iden3/circomlibjs/blob/main/src/eddsa.js#L9C31-L9C41}
 */
let initializedPromise: Promise<void> | undefined;
let eddsa: Eddsa;
let poseidon: Poseidon;

/**
 * Initialize the {@link Eddsa} and {@link Poseidon} classes from the external 
 * library only if they have not already been initialized.
 */
async function ensureInitialized() {
  if (!initializedPromise) {
    initializedPromise = (async () => {
      eddsa = await buildEddsa();
      poseidon = await buildPoseidon();
    })();
  }

  await initializedPromise;
}

/**
 * Make a new {@link EdDSAPCD} by generating a {@link EdDSAPCDProof} 
 * and deriving a {@link EdDSAPCDClaim} from the given {@link EdDSAPCDArgs}.
 * 
 * @param args - the set of arguments to make a new {@link EdDSAPCD}.
 */
export async function prove(args: EdDSAPCDArgs): Promise<EdDSAPCD> {
  await ensureInitialized();

  let message;

  if (!args.privateKey.value)
    throw new Error("No private key value provided");

  if (!args.message.value)
    throw new Error("No message value provided");
  
  try {
    // Converts to BigInt the stringified message content.
    message = args.message.value.map((fieldStr: string) => BigInt(fieldStr));
  } catch (e) {
    throw new Error("Could not convert message contents to bigint type");
  }

  // Recover or create a new PCD unique identifier.
  const id = typeof args.id.value === "string" ? args.id.value : uuid();
  const prvKey = fromHexString(args.privateKey.value);

  const hashedMessage = poseidon(message);

  // Extract the corresponding EdDSA public key from the given EdDSA private key.
  const publicKey: EDdSAPublicKey = eddsa
    .prv2pub(prvKey)
    .map(toHexString) as EDdSAPublicKey;

  // Make the signature on the message.
  const signature = toHexString(
    eddsa.packSignature(eddsa.signPoseidon(prvKey, hashedMessage))
  );

  return new EdDSAPCD(id, { message, publicKey }, { signature });
}

/**
 * Verify if a given {@link EdDSAPCDClaim} corresponds to a given {@link EdDSAPCDProof}.
 * 
 * @param pcd - the {@link EdDSAPCD} to be verified.
 * @returns true if the {@link EdDSAPCDClaim} corresponds to the {@link EdDSAPCDProof}; otherwise false.
 */
export async function verify(pcd: EdDSAPCD): Promise<boolean> {
  await ensureInitialized();

  const signature = eddsa.unpackSignature(fromHexString(pcd.proof.signature));

  const pubKey = pcd.claim.publicKey.map(fromHexString) as unknown as Point;

  const hashedMessage = poseidon(pcd.claim.message);

  return eddsa.verifyPoseidon(hashedMessage, signature, pubKey);
}

/**
 * Replace the content of an {@link EdDSAPCDArgs} converting strings to BigInt values.
 *
 * @param key - indicate the PCD argument name to convert.
 * @param value - indicate the PCD argument value to convert.
 * @returns the converted value as strings.
 */
function replacer(key: any, value: any): any {
  if (key === "message") {
    return value.map((num: bigint) => num.toString(16));
  } else {
    return value;
  }
}

/**
 * Replace the content of an {@link EdDSAPCDArgs} converting BigInt values to strings.
 * 
 * @param key - indicate the PCD argument name to convert.
 * @param value - indicate the PCD argument value to convert.
 * @returns the converted value as BigInt values.
 */
function reviver(key: any, value: any): any {
  if (key === "message") {
    return value.map((str: string) => BigInt(`0x${str}`));
  } else {
    return value;
  }
}

/**
 * Serialize an {@link EdDSAPCD} to {@link SerializedPCD<EdDSAPCD>}.
 * 
 * @param pcd - the EdDSA PCD to be serialized. 
 * @returns the serialized version of the EdDSA PCD.
 */
export async function serialize(
  pcd: EdDSAPCD
): Promise<SerializedPCD<EdDSAPCD>> {
  return {
    type: EdDSAPCDTypeName,
    pcd: JSON.stringify(pcd, replacer)
  };
}

/**
 * Deserialize a {@link SerializedPCD<EdDSAPCD>} to {@link EdDSAPCD}.
 * 
 * @param serialized - the serialized PCD to deserialize. 
 * @returns the deserialized version of the EdDSA PCD.
 */
export async function deserialize(serialized: string): Promise<EdDSAPCD> {
  const { id, claim, proof } = JSON.parse(serialized, reviver);

  requireDefinedParameter(id, "id");
  requireDefinedParameter(claim, "claim");
  requireDefinedParameter(proof, "proof");

  return new EdDSAPCD(id, claim, proof);
}

/**
 * Return the information on how the {@link EdDSAPCD} should be displayed 
 * to the user within the PCD passport.
 * 
 * @param pcd - the EdDSA PCD from which to show the information. 
 * @returns the information to display for an {@link EdDSAPCD}.
 */
export function getDisplayOptions(pcd: EdDSAPCD): DisplayOptions {
  return {
    header: "EdDSA Signature",
    displayName: "eddsa-sig-" + pcd.id.substring(0, 4)
  };
}

/** 
 * A PCD-conforming wrapper to sign (and prove) messages (signed) 
 * using an EdDSA key(pair).
 */
export const EdDSAPCDPackage: PCDPackage<
  EdDSAPCDClaim,
  EdDSAPCDProof,
  EdDSAPCDArgs,
  EdDSAInitArgs
> = {
  name: EdDSAPCDTypeName,
  renderCardBody: EdDSACardBody,
  getDisplayOptions,
  prove,
  verify,
  serialize,
  deserialize
};

/**
 * Return an {@link EDdSAPublicKey} extracted from the given 32-bytes 
 * EdDSA private key as hexadecimal string.
 * 
 * @param privateKey - the 32-bytes EdDSA private key as hexadecimal string.
 * @returns the extracted {@link EDdSAPublicKey} from the given private key.
 */
export async function getEdDSAPublicKey(
  privateKey: string
): Promise<EDdSAPublicKey> {
  await ensureInitialized();

  return eddsa
    .prv2pub(fromHexString(privateKey))
    .map(toHexString) as EDdSAPublicKey;
}
