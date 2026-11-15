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

import bleManager from "./modules/bleManager.js";
import EventHandler from "./modules/EventHandler.js";

const eventHandler = new EventHandler("connect", "disconnect", "inference", "imudata");
bleManager.propagateEventsTo(eventHandler);
let connected = false;
let connecting = null;
eventHandler.addEventListener("disconnect", () => { connected = false; });

async function loadFile(file) {
  if (file instanceof ArrayBuffer) {
    if (file.byteLength === 0) throw new Error("File is empty");
    return file;
  }
  if (typeof file !== "string") throw new Error("File must be a URL or ArrayBuffer");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(file, {signal: controller.signal});
    if (!response.ok) throw new Error(`File request failed: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error("File is empty");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

export async function connect() {
  if (connected) return;
  if (connecting) return connecting;
  connecting = (async () => {
    await bleManager.connect();
    connected = true;
    eventHandler.dispatchEvent("connect");
  })();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

export function isConnected() { return connected; }
export async function disconnect() { await bleManager.disconnect(); }
export function getState() { return bleManager.getState(); }
export function setState(state) { return bleManager.setState(state); }
export function writeMetaString(message) { return bleManager.writeMetaString(message); }
export function readMetaString() { return bleManager.readMetaString(); }
export function readVersion() { return bleManager.readVersion(); }
export function readDataProviderLabels() { return bleManager.readDataProviderLabels(); }
export function setDisableMagnetometer(value) { return bleManager.setDisableMagnetometer(value); }
export function addEventListener(...args) { return eventHandler.addEventListener(...args); }
export function removeEventListener(...args) { return eventHandler.removeEventListener(...args); }

export function calibrate() {
  if (!connected) return Promise.reject(new Error("Bluetooth is not connected"));
  return new Promise((resolve, reject) => {
    let finished = false;
    let requestSent = false;
    let enteredCalibration = false;
    let exitedCalibration = false;
    const subscriptions = [];
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscriptions.forEach(unsubscribe => unsubscribe());
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Calibration timed out")), 60000);
    subscriptions.push(bleManager.addEventListener("state-change", state => {
      if (state === "ERROR_STATE") return finish(new Error("Calibration failed on device"));
      if (state === "CALIBRATION") enteredCalibration = true;
      else if (enteredCalibration) exitedCalibration = true;
      if (requestSent && exitedCalibration) finish();
    }));
    subscriptions.push(bleManager.addEventListener("disconnect", () => finish(new Error("Bluetooth disconnected"))));
    subscriptions.push(bleManager.addEventListener("error", error => finish(error)));
    bleManager.setState("CALIBRATION").then(() => {
      requestSent = true;
      if (exitedCalibration) finish();
    }, finish);
  });
}

export async function transferFile({file, fileType}) {
  if (!connected) await connect();
  const buffer = await loadFile(file);
  return bleManager.transferFile(buffer, fileType);
}

export async function transferModel({model, numClasses, threshold, numSamples, captureDelay, useMagnetometer = true}) {
  if (!Number.isInteger(numClasses) || numClasses < 1 || numClasses > 255) throw new Error("numClasses must be 1–255");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("threshold must be 0–1");
  if (!Number.isInteger(numSamples) || numSamples < 1 || numSamples > 2147483647) throw new Error("numSamples must be a positive int32");
  if (!Number.isInteger(captureDelay) || captureDelay < 0 || captureDelay > 2147483647) throw new Error("captureDelay must be a nonnegative int32");
  if (typeof useMagnetometer !== "boolean") throw new Error("useMagnetometer must be boolean");
  if (!connected) await connect();
  const buffer = await loadFile(model);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || bytes[4] !== 84 || bytes[5] !== 70 || bytes[6] !== 76 || bytes[7] !== 51) {
    throw new Error("The response is not a TFLite model (missing TFL3 identifier)");
  }
  return bleManager.transferModel(buffer, numClasses, threshold, numSamples, captureDelay, useMagnetometer);
}
