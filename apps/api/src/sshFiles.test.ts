import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import ssh2 from "ssh2";
import {
  cleanLogLines,
  completeSshConfig,
  discoverSshFingerprint,
  extractVmIconName,
  normalizeSshConnectionError,
  openSftp,
  testSsh,
  uploadFile,
  type SshConfig,
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

test("discovers a host key without attempting authentication, then pins it", async (context) => {
  const authenticationMethods: string[] = [];
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync("ed25519").private] },
    (client) => {
      client.on("error", () => {});
      client.on("authentication", (authentication) => {
        authenticationMethods.push(authentication.method);
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
  const config: SshConfig = {
    enabled: true,
    host: "127.0.0.1",
    port: address.port,
    username: "root",
    authType: "password",
    password: "correct-password",
    privateKey: "must-not-be-sent",
    passphrase: "must-not-be-sent",
    rootPath: "/mnt/user",
  };

  const discovery = await discoverSshFingerprint(config);
  assert.match(discovery.fingerprint, /^SHA256:/);
  assert.deepEqual(authenticationMethods, []);

  await assert.rejects(testSsh({ ...config, hostFingerprint: "SHA256:wrong" }));
  assert.deepEqual(authenticationMethods, []);

  const result = await testSsh({
    ...config,
    hostFingerprint: discovery.fingerprint,
  });
  assert.equal(result.fingerprint, discovery.fingerprint);
  assert.deepEqual(authenticationMethods, [
    "none",
    "password",
    "keyboard-interactive",
  ]);
});

test("keeps transport errors handled after the SFTP session is ready", async (context) => {
  const resetConnection = Promise.withResolvers<void>();
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync("ed25519").private] },
    (client) => {
      client.on("error", () => {});
      client.on("authentication", (authentication) =>
        authentication.method === "password"
          ? authentication.accept()
          : authentication.reject(["password"]),
      );
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            sftp.once("ready", () => {
              void resetConnection.promise.then(() => {
                const connection = client as typeof client & {
                  _sock: { destroy(error: Error): void };
                };
                connection._sock.destroy(new Error("connection reset"));
              });
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
  const config: SshConfig = {
    enabled: true,
    host: "127.0.0.1",
    port: address.port,
    username: "root",
    authType: "password",
    password: "secret",
    rootPath: "/root",
  };
  config.hostFingerprint = (await discoverSshFingerprint(config)).fingerprint;

  const session = await openSftp(config);
  const closed = Promise.withResolvers<void>();
  session.client.once("close", () => closed.resolve());
  resetConnection.resolve();
  await closed.promise;
});
test("times out when the server never answers the SFTP request", async (context) => {
  const sftpRequested = Promise.withResolvers<void>();
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync("ed25519").private] },
    (client) => {
      client.on("error", () => {});
      client.on("authentication", (authentication) =>
        authentication.method === "password"
          ? authentication.accept()
          : authentication.reject(["password"]),
      );
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", () => sftpRequested.resolve());
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
  const config: SshConfig = {
    enabled: true,
    host: "127.0.0.1",
    port: address.port,
    username: "root",
    authType: "password",
    password: "secret",
    rootPath: "/root",
  };
  config.hostFingerprint = (await discoverSshFingerprint(config)).fingerprint;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const opening = openSftp(config);
  await sftpRequested.promise;
  context.mock.timers.tick(12_000);
  await assert.rejects(opening, /Timed out opening the SFTP subsystem/);
  context.mock.timers.reset();
});

test("requires a fingerprint before testing SSH credentials", async () => {
  await assert.rejects(
    testSsh({
      enabled: true,
      host: "127.0.0.1",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      rootPath: "/mnt/user",
    }),
    /fingerprint/i,
  );
});

test("only reuses stored SSH secrets for the same fully pinned identity", () => {
  const current: SshConfig = {
    enabled: true,
    host: "unraid.local",
    port: 22,
    username: "root",
    authType: "password",
    password: "stored-secret",
    rootPath: "/mnt/user",
    hostFingerprint: "SHA256:pinned",
  };
  assert.equal(
    completeSshConfig({ ...current, password: undefined }, current)?.password,
    "stored-secret",
  );

  for (const changed of [
    { host: "other.local" },
    { port: 2222 },
    { username: "admin" },
    { hostFingerprint: "SHA256:replacement" },
  ]) {
    assert.throws(
      () =>
        completeSshConfig(
          { ...current, password: undefined, ...changed },
          current,
        ),
      /password/i,
    );
  }
  assert.throws(
    () =>
      completeSshConfig(
        {
          ...current,
          authType: "privateKey",
          password: undefined,
          privateKey: undefined,
        },
        current,
      ),
    /private key/i,
  );
});

test("uploads through a temporary file without following a destination symlink", async (context) => {
  const files = new Map<string, Buffer>();
  const openFiles = new Map<number, string>();
  let nextHandle = 1;
  let followedDestinationSymlink = false;
  let symlinkTarget = Buffer.from("outside-must-stay-intact");
  let rejectReplacementAfterBackup = false;
  let swapParentBeforeInstall = false;
  let nestedParentLookups = 0;
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync("ed25519").private] },
    (client) => {
      client.on("error", () => {});
      client.on("authentication", (authentication) => {
        if (
          authentication.method === "password" &&
          authentication.username === "root" &&
          authentication.password === "secret"
        )
          authentication.accept();
        else authentication.reject(["password"]);
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            sftp
              .on("REALPATH", (requestId, path) => {
                let resolvedPath = path;
                if (
                  swapParentBeforeInstall &&
                  path === "/root/folder" &&
                  ++nestedParentLookups > 1
                ) {
                  resolvedPath = "/outside";
                }
                sftp.name(requestId, [
                  {
                    filename: resolvedPath,
                    longname: resolvedPath,
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
              .on("OPEN", (requestId, path) => {
                if (path === "/root/link.txt") {
                  followedDestinationSymlink = true;
                  symlinkTarget = Buffer.alloc(0);
                }
                const handleNumber = nextHandle++;
                const handle = Buffer.alloc(4);
                handle.writeUInt32BE(handleNumber);
                openFiles.set(handleNumber, path);
                files.set(path, Buffer.alloc(0));
                sftp.handle(requestId, handle);
              })
              .on("WRITE", (requestId, handle, offset, data) => {
                const path = openFiles.get(handle.readUInt32BE(0));
                if (!path) {
                  sftp.status(requestId, utils.sftp.STATUS_CODE.FAILURE);
                  return;
                }
                const previous = files.get(path) ?? Buffer.alloc(0);
                const contents = Buffer.alloc(
                  Math.max(previous.length, offset + data.length),
                );
                previous.copy(contents);
                data.copy(contents, offset);
                files.set(path, contents);
                sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
              })
              .on("CLOSE", (requestId, handle) => {
                openFiles.delete(handle.readUInt32BE(0));
                sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
              })
              .on("RENAME", (requestId, from, to) => {
                const contents = files.get(from);
                if (!contents) {
                  sftp.status(requestId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
                  return;
                }
                if (files.has(to)) {
                  sftp.status(requestId, utils.sftp.STATUS_CODE.FAILURE);
                  return;
                }
                if (
                  rejectReplacementAfterBackup &&
                  from.includes(".upload-") &&
                  to === "/root/rollback.txt"
                ) {
                  rejectReplacementAfterBackup = false;
                  sftp.status(requestId, utils.sftp.STATUS_CODE.FAILURE);
                  return;
                }
                files.delete(from);
                files.set(to, contents);
                sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
              })
              .on("REMOVE", (requestId, path) => {
                files.delete(path);
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
  const config: SshConfig = {
    enabled: true,
    host: "127.0.0.1",
    port: address.port,
    username: "root",
    authType: "password",
    password: "secret",
    rootPath: "/root",
  };
  const { fingerprint } = await discoverSshFingerprint(config);
  config.hostFingerprint = fingerprint;

  await uploadFile(config, "/link.txt", Readable.from("replacement"));
  assert.equal(followedDestinationSymlink, false);
  assert.equal(symlinkTarget.toString(), "outside-must-stay-intact");
  assert.equal(files.get("/root/link.txt")?.toString(), "replacement");
  assert.equal(
    [...files.keys()].some((path) => path.includes(".upload-")),
    false,
  );

  await uploadFile(config, "/normal.txt", Readable.from("normal contents"));
  assert.equal(files.get("/root/normal.txt")?.toString(), "normal contents");

  await context.test(
    "replaces an existing destination with SFTP v3",
    async () => {
      files.set("/root/existing.txt", Buffer.from("old contents"));
      await uploadFile(config, "/existing.txt", Readable.from("new contents"));
      assert.equal(files.get("/root/existing.txt")?.toString(), "new contents");
      assert.equal(
        [...files.keys()].some((path) => path.includes(".backup-")),
        false,
      );
    },
  );

  await context.test(
    "restores the destination when replacement fails",
    async () => {
      files.set("/root/rollback.txt", Buffer.from("must survive"));
      rejectReplacementAfterBackup = true;
      await assert.rejects(
        uploadFile(config, "/rollback.txt", Readable.from("must not replace")),
      );
      assert.equal(files.get("/root/rollback.txt")?.toString(), "must survive");
      assert.equal(
        [...files.keys()].some(
          (path) => path.includes(".upload-") || path.includes(".backup-"),
        ),
        false,
      );
    },
  );

  await context.test(
    "detects a swapped destination parent before rename",
    async () => {
      swapParentBeforeInstall = true;
      nestedParentLookups = 0;
      await assert.rejects(
        uploadFile(config, "/folder/swapped.txt", Readable.from("confined")),
        /destination folder changed/i,
      );
      swapParentBeforeInstall = false;
      assert.equal(files.has("/root/folder/swapped.txt"), false);
      assert.equal(
        [...files.keys()].some((path) => path.includes(".upload-")),
        false,
      );
    },
  );
});
