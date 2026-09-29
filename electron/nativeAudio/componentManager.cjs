const path = require('node:path');
const { createComponentManager: createArchiveManager, validateRelease } = require('../components/archiveManager.cjs');

// WASAPI/ASIO keeps its original version, catalog and activation directory.
function createComponentManager(options) {
    return createArchiveManager({ ...options, catalogPath: options.catalogPath
        || (!options.app.isPackaged && process.env.FOLIA_NATIVE_COMPONENT_CATALOG)
        || path.join(__dirname, 'component-catalog.json') });
}
module.exports = { createComponentManager, validateRelease };
