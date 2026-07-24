import assert from "node:assert/strict";
import test from "node:test";
import { cleanLogLines, extractVmIconName } from "./sshFiles.js";

test("normalizes terminal log output", () => {
  assert.deepEqual(cleanLogLines("\u001b[31merror\u001b[0m\r\nready\r\n"), [
    "error",
    "ready",
  ]);
});

test("bounds log output to one MiB", () => {
  const lines = cleanLogLines(`discarded\n${"x".repeat(1_048_576)}`);

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.length, 1_048_576);
});

test("extracts a safe VM icon filename from libvirt metadata", () => {
  assert.equal(
    extractVmIconName(
      `<metadata><vmtemplate xmlns="unraid" name="Linux" icon="linux.png" os="linux"/></metadata>`,
    ),
    "linux.png",
  );
  assert.equal(
    extractVmIconName(`<vmtemplate icon='/custom/windows.webp'/>`),
    "windows.webp",
  );
  assert.equal(extractVmIconName(`<vmtemplate icon="active.svg"/>`), null);
  assert.equal(extractVmIconName("<metadata/>"), null);
});
