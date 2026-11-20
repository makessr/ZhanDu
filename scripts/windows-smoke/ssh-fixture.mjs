import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export async function startSshFixture(ssh2, directory) {
  const password = randomBytes(24).toString("base64url");
  const keyPassphrase = randomBytes(24).toString("base64url");
  function privateKey(passphrase) {
    return generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { type: "pkcs1", format: "pem", ...(passphrase && { cipher: "aes-256-cbc", passphrase }) },
    }).privateKey;
  }
  const hostKey = privateKey();
  const deviceKey = privateKey(keyPassphrase);
  const deviceKeyFile = join(directory, "fixture-private-key");
  await writeFile(deviceKeyFile, deviceKey, { mode: 0o600 });
  const authorized = new Map([["fineshell-key", ssh2.utils.parseKey(deviceKey, keyPassphrase)]]);
  const fingerprint = "SHA256:" + createHash("sha256").update(ssh2.utils.parseKey(hostKey).getPublicSSH())
    .digest("base64").replace(/=+$/, "");
  const counts = { password: 0, publickey: 0 };
  const sockets = new Set();
  const algorithms = {
    kex: ["curve25519-sha256"],
    serverHostKey: ["rsa-sha2-512", "rsa-sha2-256"],
    cipher: ["aes128-ctr"],
    hmac: ["hmac-sha2-256"],
  };
  const server = new ssh2.Server({ hostKeys: [hostKey], algorithms }, (client) => {
    client.on("error", () => client.end());
    client.on("authentication", (auth) => {
      const key = authorized.get(auth.username);
      if (auth.method === "password" && auth.username === "fineshell-password" && auth.password === password) {
        counts.password++;
        auth.accept();
      } else if (auth.method === "publickey" && key && auth.key.data.equals(key.getPublicSSH())) {
        if (!auth.signature || key.verify(auth.blob, auth.signature, auth.hashAlgo) === true) {
          if (auth.signature) counts.publickey++;
          auth.accept();
        } else auth.reject(["publickey"]);
      } else auth.reject([key ? "publickey" : "password"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("window-change", (acceptResize) => acceptResize?.());
      session.on("env", (acceptEnv) => acceptEnv?.());
      session.on("shell", (acceptShell) => acceptShell().write("FINESHELL_SMOKE_READY\r\n"));
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        if (info.command.includes("cpu_percent=") && info.command.includes("memory_kib=")) {
          stream.write("hostname=smoke-fixture\noperating_system=Debian\nkernel=6.1\nuptime_seconds=300\n" +
            "cpu_percent=24.0\nmemory_kib=2048000,1536000\ndisk_kib=10485760,2621440,7864320\n" +
            "load_average=0.12,0.07,0.04\nnetwork_bytes=952932,93100\n");
        }
        stream.exit(0);
        stream.end();
      });
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const attributes = { mode: 0o040755, size: 0, uid: 1000, gid: 1000, atime: 0, mtime: 0 };
        const entry = (filename) => ({ filename, longname: filename,
          attrs: { ...attributes, mode: 0o100644 } });
        const entries = [entry("fineshell-smoke.txt"),
          ...Array.from({ length: 127 }, (_, index) => entry(`zz-${index}.txt`))];
        const handle = Buffer.from([0]);
        let batch = 0;
        sftp.on("REALPATH", (id) => sftp.name(id, [{ filename: "/", longname: "/", attrs: attributes }]));
        sftp.on("STAT", (id) => sftp.attrs(id, attributes));
        sftp.on("LSTAT", (id) => sftp.attrs(id, attributes));
        sftp.on("OPENDIR", (id) => { batch = 0; sftp.handle(id, handle); });
        sftp.on("READDIR", (id) => {
          switch (batch++) {
            case 0:
              sftp.name(id, entries);
              break;
            case 1:
              setTimeout(() => sftp.name(id, [entry("after-preview.txt")]), 1500);
              break;
            default:
              sftp.status(id, 1);
          }
        });
        sftp.on("CLOSE", (id) => sftp.status(id, 0));
      });
    }));
  });
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    server.injectSocket(socket);
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return { password, keyPassphrase, deviceKeyFile, fingerprint, counts, port: listener.address().port,
    allowPublicKey: (username, publicKey) => {
      const key = ssh2.utils.parseKey(publicKey);
      if (key instanceof Error) throw key;
      authorized.set(username, key);
    },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      listener.close(resolve);
    }) };
}
