"use strict";

import { RadioReceiver } from "./radio-core.js";

const FM_SOCKET =
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/fmrx`;

export const FM_STATION = {
    id: "FM",
    name: "103.5 Barangay LS",
    frequency: "DXRV 103.5 MHz FM",
    program: "Music & Entertainment",
    socket: FM_SOCKET,
    artwork: "assets/notif_fm.png"
};

export function createFMReceiver(callbacks = {}) {
    return new RadioReceiver({
        name: "FM",
        url: FM_STATION.socket,
        onStatus: callbacks.onStatus,
        onFormat: callbacks.onFormat,
        onError: callbacks.onError,
        onPacket: callbacks.onPacket
    });
}
