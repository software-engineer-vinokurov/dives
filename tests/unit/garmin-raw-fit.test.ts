import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractFitFromZip } from "../../lib/garmin/raw-fit";

describe("Garmin Raw FIT Extractor", () => {
  it("extracts the first .fit file from a valid zip buffer", async () => {
    const zip = new JSZip();
    zip.file("ignored.txt", "Some text");
    zip.file("activity_123.fit", new Uint8Array([0, 1, 2, 3]));
    
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const fitBuffer = await extractFitFromZip(zipBuffer);
    
    expect(fitBuffer).toBeDefined();
    expect(fitBuffer.length).toBe(4);
    expect(fitBuffer[2]).toBe(2);
  });

  it("throws an error if no .fit file is found in the zip", async () => {
    const zip = new JSZip();
    zip.file("ignored.txt", "Some text");
    
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    
    await expect(extractFitFromZip(zipBuffer)).rejects.toThrow("No .fit file found inside the downloaded zip.");
  });
});
