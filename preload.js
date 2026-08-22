"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mentionExporter", {
  getConfig: () => ipcRenderer.invoke("LiteLoader.mention_exporter.getConfig"),
  saveConfig: (config) => ipcRenderer.invoke("LiteLoader.mention_exporter.saveConfig", config),
  testOneBot: (onebot) => ipcRenderer.invoke("LiteLoader.mention_exporter.testOneBot", onebot),
});
