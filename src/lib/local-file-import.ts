export type LocalFileImportEpoch = { current: number };

export function beginLocalFileImport(epoch: LocalFileImportEpoch) {
  epoch.current += 1;
  return epoch.current;
}

export function cancelLocalFileImport(epoch: LocalFileImportEpoch) {
  epoch.current += 1;
}

export function isCurrentLocalFileImport(epoch: LocalFileImportEpoch, requestId: number) {
  return epoch.current === requestId;
}
