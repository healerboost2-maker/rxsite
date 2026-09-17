"use strict";

import { RadioReceiver } from "./radio-core.js";

const AM_SOCKET =
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/amrx`;

export const AM_STATION = {
    id: "AM",
    name: "GMA Super Radyo Davao",
    frequency: "DXGM 1125 kHz",
    program: "News & Commentary",
    socket: AM_SOCKET,
    artwork: "assets/notif_am.png"
};

export function createAMReceiver(callbacks = {}) {
    return new RadioReceiver({
        name: "AM",
        url: AM_STATION.socket,
        onStatus: callbacks.onStatus,
        onFormat: callbacks.onFormat,
        onError: callbacks.onError,
        onPacket: callbacks.onPacket
    });
}
