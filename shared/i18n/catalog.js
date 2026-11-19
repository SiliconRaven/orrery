import app from './en-app.js';
import ui from './en-ui.js';
import workbench from './en-workbench.js';
import desktop from './en-desktop.js';
import updates from './en-updates.js';
import install from './en-install.js';

export default Object.freeze({ ...app, ...ui, ...workbench, ...desktop, ...updates, ...install });
