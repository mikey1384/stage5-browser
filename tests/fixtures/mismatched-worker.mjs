function respond(id, result) {
  if (process.connected) {
    process.send({ kind: 'response', id, ok: true, result });
  }
}

process.on('message', (message) => {
  if (message?.kind !== 'request' || message.command !== 'initialize') {
    return;
  }
  const startedAt = new Date().toISOString();
  respond(message.id, {
    ready: true,
    workerPid: process.pid,
    runtime: {
      component: 'worker',
      version: '0.3.0',
      protocolVersion: 2,
      processId: process.pid,
      startedAt,
      buildModifiedAt: startedAt,
      artifactFingerprint: 'mismatch',
      currentArtifactFingerprint: 'mismatch',
      currentVersion: '0.3.0',
      currentProtocolVersion: 2,
      currentToolCatalogVersion: 2,
      compatibleUpdateAvailable: false,
      restartRequired: false,
      restartReason: null,
      suggestedAction: null,
    },
  });
});

process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
