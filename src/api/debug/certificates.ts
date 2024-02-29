import path from "path";
import {promises as fs} from "fs";
import * as os from "os";
import IBMi from "../IBMi";
import * as dns from 'dns';
import {window} from "vscode";

const serverCertName = `debug_service.pfx`;
const clientCertName = `debug_service.crt`;

export const LEGACY_CERT_DIRECTORY = `/QIBM/ProdData/IBMiDebugService/bin/certs`;
export const DEFAULT_CERT_DIRECTORY = `/QIBM/UserData/IBMiDebugService/certs`;

function getRemoteCertDirectory(connection: IBMi) {
  return connection.config?.debugCertDirectory!;
}

function resolveHostnameToIP(hostName: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dns.lookup(hostName, (err, res) => {
      if (err) {
        resolve(undefined);
      } else {
        resolve(res);
      }
    });
  });
}

async function getExtFileConent(host: string, connection: IBMi) {
  const ipRegexExp = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/gi;
  let hostname = undefined;
  let ipAddr = undefined;

  if (ipRegexExp.test(host)) {
    ipAddr = host;
    const hostnameResult = await connection.sendCommand({
      command: `hostname`
    });

    if (hostnameResult.stdout) {
      hostname = hostnameResult.stdout;
    } else {
      window.showWarningMessage(`Hostname cannot be retrieved from IBM i, certificate will be created only using the IP address!`);
    }
  } else {
    hostname = host;
    ipAddr = await resolveHostnameToIP(host);
  }

  let extFileContent;
  if (hostname && ipAddr) {
    extFileContent = `subjectAltName=DNS:${hostname},IP:${ipAddr}`;
  } else if (hostname) {
    extFileContent = `subjectAltName=DNS:${hostname}`;
  } else {
    extFileContent = `subjectAltName=IP:${ipAddr}`;
  }

  return extFileContent;
}

export function getRemoteServerCertPath(connection: IBMi) {
  return path.posix.join(getRemoteCertDirectory(connection), serverCertName);
}

export function getRemoteClientCertPath(connection: IBMi) {
  return path.posix.join(getRemoteCertDirectory(connection), clientCertName);
}

export async function remoteServerCertExists(connection: IBMi) {
  const pfxPath = getRemoteServerCertPath(connection);

  const dirList = await connection.sendCommand({
    command: `ls -p ${pfxPath}`
  });

  const list = dirList.stdout.split(`\n`);

  return list.includes(pfxPath);
}

export async function remoteClientCertExists(connection: IBMi) {
  const crtPath = getRemoteClientCertPath(connection);

  const dirList = await connection.sendCommand({
    command: `ls -p ${crtPath}`
  });

  const list = dirList.stdout.split(`\n`);

  return list.includes(crtPath);
}

/**
 * Generate all certifcates on the server
 */
export async function setup(connection: IBMi) {
  const host = connection.currentHost;
  const extFileContent = await getExtFileConent(host, connection);

  const commands = [
    `openssl genrsa -out debug_service_ca.key 2048`,
    `openssl req -x509 -new -nodes -key debug_service_ca.key -sha256 -days 1825 -out debug_service_ca.pem -subj '/CN=${host}'`,
    `openssl genrsa -out debug_service.key 2048`,
    `openssl req -new -key debug_service.key -out debug_service.csr -subj '/CN=${host}'`,
    `openssl x509 -req -in debug_service.csr -CA debug_service_ca.pem -CAkey debug_service_ca.key -CAcreateserial -out debug_service.crt -days 1095 -sha256 -sha256 -req -extfile <(printf "${extFileContent}")`,
    `openssl pkcs12 -export -out debug_service.pfx -inkey debug_service.key -in debug_service.crt -password pass:${host}`
  ];

  const directory = getRemoteCertDirectory(connection);

  const mkdirResult = await connection.sendCommand({
    command: `mkdir -p ${directory}`
  });

  if (mkdirResult.code && mkdirResult.code > 0) {
    throw new Error(`Failed to create certificate directory: ${directory}`);
  }

  const creationResults = await connection.sendCommand({
    command: commands.join(` && `),
    directory
  });

  if (creationResults.code && creationResults.code > 0) {
    throw new Error(`Failed to create certificates.`);
  }
}

export function downloadClientCert(connection: IBMi) {
  const remotePath = getRemoteClientCertPath(connection);
  const localPath = getLocalCertPath(connection);

  return connection.downloadFile(localPath, remotePath);
}

export function getLocalCertPath(connection: IBMi) {
  const host = connection.currentHost;
  return path.join(os.homedir(), `${host}_${clientCertName}`);
}

export async function localClientCertExists(connection: IBMi) {
  try {
    await fs.stat(getLocalCertPath(connection));
    // TODO: if local exists, but it's out of date with the server? e.g. md5 is different for example
    return true;
  } catch (e) {
    return false;
  }
}