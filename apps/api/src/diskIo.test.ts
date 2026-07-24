import assert from "node:assert/strict";
import test from "node:test";
import { calculateDiskIoRates } from "./diskIo.js";

test("calculates per-device byte rates between samples", () => {
  const rates = calculateDiskIoRates(
    [{ device: "nvme0n1", readBytes: "1000", writeBytes: "2000" }],
    [{ device: "nvme0n1", readBytes: "5001000", writeBytes: "2002000" }],
    2_000,
  );

  assert.deepEqual(rates, [
    {
      device: "nvme0n1",
      readBytesPerSecond: 2_500_000,
      writeBytesPerSecond: 1_000_000,
    },
  ]);
});

test("returns measuring state until a matching sample exists", () => {
  assert.deepEqual(
    calculateDiskIoRates(
      undefined,
      [{ device: "sda", readBytes: "512", writeBytes: "1024" }],
      0,
    ),
    [
      {
        device: "sda",
        readBytesPerSecond: null,
        writeBytesPerSecond: null,
      },
    ],
  );
});

test("does not report a negative rate after counters reset", () => {
  const [rate] = calculateDiskIoRates(
    [{ device: "sda", readBytes: "4096", writeBytes: "8192" }],
    [{ device: "sda", readBytes: "0", writeBytes: "0" }],
    1_000,
  );

  assert.equal(rate?.readBytesPerSecond, null);
  assert.equal(rate?.writeBytesPerSecond, null);
});
