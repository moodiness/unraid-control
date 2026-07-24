import type { DiskIoCounter } from "./sshFiles.js";

export type DiskIoRate = {
  device: string;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
};

function bytesPerSecond(
  current: string,
  previous: string | undefined,
  elapsedMs: number,
) {
  if (previous === undefined || elapsedMs <= 0) return null;
  const delta = BigInt(current) - BigInt(previous);
  if (delta < 0n) return null;
  return Number((delta * 1_000n) / BigInt(Math.round(elapsedMs)));
}

export function calculateDiskIoRates(
  previous: DiskIoCounter[] | undefined,
  current: DiskIoCounter[],
  elapsedMs: number,
): DiskIoRate[] {
  const previousByDevice = new Map(
    previous?.map((counter) => [counter.device, counter]),
  );
  return current.map((counter) => {
    const prior = previousByDevice.get(counter.device);
    return {
      device: counter.device,
      readBytesPerSecond: bytesPerSecond(
        counter.readBytes,
        prior?.readBytes,
        elapsedMs,
      ),
      writeBytesPerSecond: bytesPerSecond(
        counter.writeBytes,
        prior?.writeBytes,
        elapsedMs,
      ),
    };
  });
}
