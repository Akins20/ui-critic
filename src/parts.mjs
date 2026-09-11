import { readFile } from "node:fs/promises";

/**
 * The provider-neutral prompt parts every module builds: a text part and an
 * inline image part read from a PNG or JPEG file. Each provider client turns
 * these into its own wire shape.
 */

/** Builds an inline image part from a PNG or JPEG file. */
export async function imagePart(file) {
  const data = await readFile(file);
  const mimeType = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
  return { inlineData: { mimeType, data: data.toString("base64") } };
}

export const text = (t) => ({ text: t });
