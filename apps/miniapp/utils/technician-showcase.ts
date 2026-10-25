import type { TechnicianShowcasePortrait } from "@zydj/contracts";
import { api } from "./api";
export type ShowcasePortraitView = TechnicianShowcasePortrait & {
  imageUrl: string;
};
export async function loadShowcasePortraits(): Promise<ShowcasePortraitView[]> {
  const rows = await api<TechnicianShowcasePortrait[]>("/technician-showcase");
  const base = getApp<{ globalData: { apiBaseUrl: string } }>().globalData
    .apiBaseUrl;
  return rows
    .filter(
      (row) =>
        /^[A-Za-z0-9-]+$/.test(row.id) &&
        row.imagePath === `/technician-showcase/photos/${row.id}`,
    )
    .map((row) => ({ ...row, imageUrl: `${base}${row.imagePath}` }));
}
export function previewShowcasePortrait(
  rows: ShowcasePortraitView[],
  id?: string,
) {
  const selected = rows.find((row) => row.id === id);
  if (selected)
    wx.previewImage({
      current: selected.imageUrl,
      urls: rows.map((row) => row.imageUrl),
    });
}
