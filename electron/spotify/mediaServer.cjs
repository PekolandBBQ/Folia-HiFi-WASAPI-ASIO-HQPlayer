const { createFileServer } = require('../media/fileServer.cjs');

// Preserve the Spotify import boundary while sharing the bounded, revocable HTTP transport.
module.exports = { createMediaServer: createFileServer };
