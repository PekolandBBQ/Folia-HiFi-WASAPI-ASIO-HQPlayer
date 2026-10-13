'use strict';
const { app, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const { configurePrivateDevelopment, disablePrivateUpdates } = require('./privateDevelopment.cjs');
const { installPrivatePreviewDiagnostics } = require('./debug/privatePreviewDiagnostics.cjs');
const buildInfo = require('./private-development-build.json');
const approved = require('./private-development-approved.json');

// packaging/exclusive/private-development-entry.cjs — launched as an app directory by unmodified Electron.
const { profile } = configurePrivateDevelopment({ app, resourcesPath: process.resourcesPath, approved, buildInfo });
const controller = installPrivatePreviewDiagnostics({ app, ipcMain, dialog, shell, profile,
    rendererEntry: path.resolve(__dirname, '../dist/index.html'), buildInfo });
const Store = require('electron-store').default || require('electron-store');
disablePrivateUpdates({ app, profile, Store });
require('./main.cjs');
controller.observeExistingRejectionHandler();
