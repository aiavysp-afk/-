"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadShowcasePortraits = loadShowcasePortraits;
exports.previewShowcasePortrait = previewShowcasePortrait;
const api_1 = require("./api");
async function loadShowcasePortraits() {
    const rows = await (0, api_1.api)("/technician-showcase");
    const base = getApp().globalData
        .apiBaseUrl;
    return rows
        .filter((row) => /^[A-Za-z0-9-]+$/.test(row.id) &&
        row.imagePath === `/technician-showcase/photos/${row.id}`)
        .map((row) => ({ ...row, imageUrl: `${base}${row.imagePath}` }));
}
function previewShowcasePortrait(rows, id) {
    const selected = rows.find((row) => row.id === id);
    if (selected)
        wx.previewImage({
            current: selected.imageUrl,
            urls: rows.map((row) => row.imageUrl),
        });
}
