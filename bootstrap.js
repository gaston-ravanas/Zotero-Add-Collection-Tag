// Zotero 7+ bootstrap plugin. `Zotero` and `Services` are available in this scope, and
// startup() is only called once Zotero has been initialized.

var AddCollectionTag;

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "addCollectionTag.js");
  Zotero.debug("Add Collection Tag: starting " + version);
  await AddCollectionTag.init({ id, version, rootURI });
  // Handy for debugging from Tools → Developer → Run JavaScript
  Zotero.AddCollectionTag = AddCollectionTag;

  Zotero.PreferencePanes.register({
    pluginID: id,
    id: "addcollectiontag-prefpane",
    src: rootURI + "preferences.xhtml",
    label: "Add Collection Tag",
  });

  for (const window of Zotero.getMainWindows()) {
    AddCollectionTag.addToWindow(window);
  }
}

function onMainWindowLoad({ window }) {
  AddCollectionTag?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  AddCollectionTag?.removeFromWindow(window);
}

async function shutdown({ id, version, rootURI }, reason) {
  if (reason == APP_SHUTDOWN) {
    // Still save the record of added tags, but skip window cleanup
    await AddCollectionTag?.shutdown();
    return;
  }
  for (const window of Zotero.getMainWindows()) {
    AddCollectionTag?.removeFromWindow(window);
  }
  await AddCollectionTag?.shutdown();
  delete Zotero.AddCollectionTag;
  AddCollectionTag = undefined;
}

function install() {}

function uninstall() {}
