import assert from "node:assert/strict";
import test from "node:test";
import ssh2 from "ssh2";
import {
  cleanLogLines,
  extractVmIconName,
  normalizeSshConnectionError,
  testSsh,
} from "./sshFiles.js";
const { Server, utils } = ssh2;

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

test("explains rejected SSH credentials", () => {
  const source = Object.assign(
    new Error("All configured authentication methods failed"),
    { level: "client-authentication" },
  );
  const normalized = normalizeSshConnectionError(source);

  assert.match(normalized.message, /SSH authentication failed/);
  assert.match(normalized.message, /username and password/);
  assert.equal(normalized.cause, source);
});

test("connects to a keyboard-interactive SSH server with a password", async (context) => {
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync("ed25519").private] },
    (client) => {
      client.on("authentication", (authentication) => {
        if (
          authentication.method !== "keyboard-interactive" ||
          authentication.username !== "root"
        ) {
          authentication.reject(["keyboard-interactive"]);
          return;
        }
        authentication.prompt(
          [{ prompt: "Password: ", echo: false }],
          (answers) => {
            if (answers[0] === "correct-password") authentication.accept();
            else authentication.reject(["keyboard-interactive"]);
          },
        );
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            const handle = Buffer.alloc(4);
            sftp
              .on("REALPATH", (requestId, path) => {
                sftp.name(requestId, [
                  {
                    filename: path,
                    longname: path,
                    attrs: {
                      mode: 0o40755,
                      uid: 0,
                      gid: 0,
                      size: 0,
                      atime: 0,
                      mtime: 0,
                    },
                  },
                ]);
              })
              .on("OPENDIR", (requestId) => {
                sftp.handle(requestId, handle);
              })
              .on("READDIR", (requestId) => {
                sftp.status(requestId, utils.sftp.STATUS_CODE.EOF);
              })
              .on("CLOSE", (requestId) => {
                sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
              });
          });
        });
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const result = await testSsh({
    enabled: true,
    host: "127.0.0.1",
    port: address.port,
    username: "root",
    authType: "password",
    password: "correct-password",
    rootPath: "/mnt/user",
  });

  assert.match(result.fingerprint, /^SHA256:/);
});
