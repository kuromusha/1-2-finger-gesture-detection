/* Copyright 2021 Google LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================
Copyright (C) 2026 Ken'ichi Kuromusha modified, Apache License 2.0
==============================================================================*/


import EventHandler from "./EventHandler.js";

const eventHandler = new EventHandler("error", "progress", "begin", "completed");
const PREFIX = "bf88b656-";
const SUFFIX = "-4a61-86e0-769c741026c0";
let characteristics = null;
let pending = null;
const TRANSFER_TIMEOUT_MS = 120000;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of new Uint8Array(buffer)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function active(transfer) {
  if (pending !== transfer) throw new Error("Transfer is no longer active");
}

function fail(transfer, error) {
  if (pending !== transfer) return;
  pending = null;
  clearTimeout(transfer.timer);
  transfer.rejectStart(error);
  transfer.reject(error);
  eventHandler.dispatchEvent("error", error);
}

async function complete(transfer) {
  if (pending !== transfer || !transfer.sentAll || !transfer.success || transfer.checking) return;
  transfer.checking = true;
  try {
    const value = await characteristics.checksum.readValue();
    active(transfer);
    if (value.getUint32(0, true) !== transfer.checksum) {
      throw new Error("File checksum mismatch");
    }
    pending = null;
    clearTimeout(transfer.timer);
    transfer.resolve();
    eventHandler.dispatchEvent("completed");
  } catch (error) {
    fail(transfer, error);
  }
}

function onStatus(event) {
  if (!characteristics || event.target !== characteristics.status || !pending) return;
  const transfer = pending;
  const status = event.target.value.getUint32(0, true);
  if (status === 2 && !transfer.started) {
    transfer.started = true;
    transfer.resolveStart();
    eventHandler.dispatchEvent("begin");
  } else if (status === 1) {
    fail(transfer, new Error("Device rejected the file transfer"));
  } else if (status === 0 && transfer.started) {
    transfer.success = true;
    void complete(transfer);
  }
}

function onErrorMessage(event) {
  if (!characteristics || event.target !== characteristics.error || !pending) return;
  const value = event.target.value;
  const message = new TextDecoder().decode(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  ).replace(/\0+$/, "");
  fail(pending, new Error(message || "File transfer failed"));
}

function reset() {
  if (pending) fail(pending, new Error("Bluetooth disconnected or transfer reset"));
  if (characteristics) {
    characteristics.status.removeEventListener("characteristicvaluechanged", onStatus);
    characteristics.error.removeEventListener("characteristicvaluechanged", onErrorMessage);
  }
  characteristics = null;
}

async function setupService(service) {
  reset();
  const names = {block: "3000", length: "3001", maximum: "3002", checksum: "3003",
    command: "3004", status: "3005", error: "3006"};
  const found = {};
  for (const [name, id] of Object.entries(names)) {
    found[name] = await service.getCharacteristic(PREFIX + id + SUFFIX);
  }
  characteristics = found;
  found.status.addEventListener("characteristicvaluechanged", onStatus);
  found.error.addEventListener("characteristicvaluechanged", onErrorMessage);
  try {
    await found.status.startNotifications();
    await found.error.startNotifications();
  } catch (error) {
    reset();
    throw error;
  }
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

async function write(transfer, characteristic, value) {
  active(transfer);
  await characteristic.writeValue(value);
  active(transfer);
}

async function send(transfer, buffer, connection) {
  const maximum = await connection.maximum.readValue();
  active(transfer);
  if (buffer.byteLength > maximum.getUint32(0, true)) {
    throw new Error("File exceeds the device's maximum transfer size");
  }
  await write(transfer, connection.length, uint32(buffer.byteLength));
  await write(transfer, connection.checksum, uint32(transfer.checksum));
  await write(transfer, connection.command, uint32(1));
  // Wait for the device before sending any blocks, regardless of notification timing.
  await transfer.ready;
  active(transfer);
  for (let offset = 0; offset < buffer.byteLength; offset += 128) {
    const length = Math.min(128, buffer.byteLength - offset);
    await write(transfer, connection.block, new Uint8Array(buffer, offset, length));
    eventHandler.dispatchEvent("progress", (offset + length) / buffer.byteLength);
  }
  transfer.sentAll = true;
  await complete(transfer);
}

function transferFile(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    return Promise.reject(new Error("File must be a nonempty ArrayBuffer"));
  }
  if (!characteristics) return Promise.reject(new Error("File transfer is not connected"));
  if (pending) return Promise.reject(new Error("Another file transfer is in progress"));
  const transfer = {checksum: crc32(buffer), started: false, sentAll: false, success: false};
  transfer.ready = new Promise((resolve, reject) => {
    transfer.resolveStart = resolve;
    transfer.rejectStart = reject;
  });
  // A failure may occur before send() reaches the start-notification wait.
  transfer.ready.catch(() => {});
  const result = new Promise((resolve, reject) => {
    transfer.resolve = resolve;
    transfer.reject = reject;
  });
  pending = transfer;
  transfer.timer = setTimeout(() => fail(transfer, new Error("File transfer timed out; reconnect before retrying")), TRANSFER_TIMEOUT_MS);
  void send(transfer, buffer, characteristics).catch(error => fail(transfer, error));
  return result;
}

async function cancelTransfer() {
  const connection = characteristics;
  if (pending) fail(pending, new Error("File transfer cancelled"));
  if (connection) await connection.command.writeValue(uint32(2));
}

export default {
  setupService, transferFile, cancelTransfer, reset,
  addEventListener(...args) { return eventHandler.addEventListener(...args); },
  removeEventListener(...args) { return eventHandler.removeEventListener(...args); }
};
