import "server-only";
import JSZip from "jszip";
import { Decoder, Stream } from "@garmin/fitsdk";

export async function extractFitFromZip(zipBuffer: Buffer): Promise<Buffer> {
  const isZip = zipBuffer.length > 4 && zipBuffer.readUInt32LE(0) === 0x04034b50;
  if (!isZip) {
    return zipBuffer; // maybe it's already a raw FIT
  }
  
  const zip = await JSZip.loadAsync(zipBuffer);
  const fileNames = Object.keys(zip.files);
  const fitFileName = fileNames.find(name => name.toLowerCase().endsWith(".fit"));
  
  if (!fitFileName) {
    throw new Error("No .fit file found inside the downloaded zip.");
  }
  
  const fitFile = zip.files[fitFileName];
  const fitBuffer = await fitFile.async("nodebuffer");
  return fitBuffer;
}

export function parseFitBuffer(buffer: Buffer) {
  const stream = Stream.fromBuffer(buffer);
  const decoder = new Decoder(stream);
  
  if (!decoder.isFIT()) {
    throw new Error("Invalid FIT file structure");
  }
  
  const { messages, errors } = decoder.read();
  
  if (errors && errors.length > 0) {
    console.warn("FIT parsing errors:", errors);
  }
  
  return messages;
}
