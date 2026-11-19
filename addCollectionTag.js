/* global Zotero, Services, IOUtils, PathUtils */

// Keeps a tag named after each collection on the items in that collection.
//
// Every change is handled the same way: work out which tags an item *should* have from
// the collections it is in right now, then add the missing ones and remove the ones the
// plugin added earlier that no longer apply. Renaming, moving, trashing, restoring or
// deleting a collection, and adding/removing/moving items, all reduce to that.
//
// The plugin only ever removes tags it added itself (or adopted during a full sync), so
// a tag you typed by hand, or a keyword imported with an item, is never removed even if
// it happens to match a collection name. Which tags were added by the plugin is recorded
// in add-collection-tag.json in the Zotero data directory.

var AddCollectionTag = {
  PREF_BRANCH: "extensions.addcollectiontag.",
  STATE_FILE: "add-collection-tag.json",
  TAG_TYPE: 1, // automatic tag
  BATCH_SIZE: 50,
  EVENT_DELAY: 500,
  MENU_IDS: ["addcollectiontag-menu-separator", "addcollectiontag-menu-sync", "addcollectiontag-menu-remove"],

  id: null,
  version: null,
  rootURI: null,
  notifierID: null,
  prefObserverIDs: [],
  // "libraryID/itemKey" -> Set of tag names added by the plugin
  managed: new Map(),
  pendingItemIDs: new Set(),
  pendingCollectionIDs: new Set(),
  pendingFullSync: false,
  flushScheduled: false,
  queue: Promise.resolve(),
  stateDirty: false,
  shuttingDown: false,

  // ---------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------

  async init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.shuttingDown = false;
    await this.loadState();

    this.notifierID = Zotero.Notifier.registerObserver(
      this,
      ["item", "collection", "collection-item"],
      "addCollectionTag",
    );
    for (const name of ["includeParents", "tagChildItems", "removeTags", "autoSync"]) {
      this.prefObserverIDs.push(
        Zotero.Prefs.registerObserver(
          this.PREF_BRANCH + name,
          () => this.onPrefChanged(name),
          true,
        ),
      );
    }
  },

  async shutdown() {
    this.shuttingDown = true;
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    for (const observerID of this.prefObserverIDs) {
      Zotero.Prefs.unregisterObserver(observerID);
    }
    this.prefObserverIDs = [];
    // Let any running sync finish so its record of added tags is saved
    try {
      await this.queue;
    }
    catch (e) {}
    await this.saveState();
  },

  addToWindow(window) {
    const doc = window.document;
    const popup = doc.getElementById("menu_ToolsPopup");
    if (!popup || doc.getElementById("addcollectiontag-menu-sync")) {
      return;
    }
    const separator = doc.createXULElement("menuseparator");
    separator.id = "addcollectiontag-menu-separator";

    const sync = doc.createXULElement("menuitem");
    sync.id = "addcollectiontag-menu-sync";
    sync.setAttribute("label", "Sync Collection Tags");
    sync.addEventListener("command", () => this.runFullSync());

    const remove = doc.createXULElement("menuitem");
    remove.id = "addcollectiontag-menu-remove";
    remove.setAttribute("label", "Remove Collection Tags…");
    remove.addEventListener("command", () => this.runRemoveAll({ window }));

    popup.append(separator, sync, remove);
  },

  removeFromWindow(window) {
    for (const id of this.MENU_IDS) {
      window.document.getElementById(id)?.remove();
    }
  },

  getPref(name) {
    return Zotero.Prefs.get(this.PREF_BRANCH + name, true);
  },

  setPref(name, value) {
    Zotero.Prefs.set(this.PREF_BRANCH + name, value, true);
  },

  log(msg) {
    Zotero.debug("Add Collection Tag: " + msg);
  },

  // ---------------------------------------------------------------------------------------
  // Record of tags added by the plugin
  // ---------------------------------------------------------------------------------------

  get statePath() {
    return PathUtils.join(Zotero.DataDirectory.dir, this.STATE_FILE);
  },

  async loadState() {
    this.managed = new Map();
    try {
      if (!(await IOUtils.exists(this.statePath))) {
        return;
      }
      const json = await IOUtils.readJSON(this.statePath);
      for (const [key, tags] of Object.entries(json.items || {})) {
        if (Array.isArray(tags) && tags.length) {
          this.managed.set(key, new Set(tags));
        }
      }
    }
    catch (e) {
      // A corrupt file only means previously added tags won't be removed automatically;
      // "Sync Collection Tags" re-adopts them
      Zotero.logError(e);
    }
  },

  async saveState() {
    if (!this.stateDirty) {
      return;
    }
    this.stateDirty = false;
    const items = {};
    for (const [key, tags] of this.managed) {
      items[key] = [...tags].sort();
    }
    try {
      await IOUtils.writeJSON(
        this.statePath,
        { version: 1, items },
        { tmpPath: this.statePath + ".tmp" },
      );
    }
    catch (e) {
      this.stateDirty = true;
      Zotero.logError(e);
    }
  },

  stateKey(libraryID, key) {
    return libraryID + "/" + key;
  },

  // ---------------------------------------------------------------------------------------
  // Notifier
  // ---------------------------------------------------------------------------------------

  notify(event, type, ids, extraData) {
    try {
      this.handleEvent(event, type, ids, extraData || {});
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  handleEvent(event, type, ids, extraData) {
    // Forget items that no longer exist, even with automatic syncing off
    if (type == "item" && event == "delete") {
      for (const id of ids) {
        const data = extraData[id];
        if (data && data.libraryID !== undefined && data.key) {
          if (this.managed.delete(this.stateKey(data.libraryID, data.key))) {
            this.stateDirty = true;
          }
        }
      }
      this.scheduleFlush();
      return;
    }

    if (!this.getPref("autoSync")) {
      return;
    }

    if (type == "collection-item") {
      // ids are "collectionID-itemID"
      for (const pair of ids) {
        const itemID = parseInt(String(pair).split("-")[1]);
        if (itemID) {
          this.pendingItemIDs.add(itemID);
        }
      }
    }
    else if (type == "item") {
      if (event == "add") {
        // New child attachments/notes aren't in collections themselves, so they don't get
        // a collection-item event
        for (const id of ids) {
          this.pendingItemIDs.add(id);
        }
      }
      else if (event == "modify") {
        // Only interested in a child item moving to another parent (or becoming standalone).
        // Ignoring other changes means our own tag edits don't trigger more work.
        for (const id of ids) {
          const changed = extraData[id] && extraData[id].changed;
          if (changed && "parentKey" in changed) {
            this.pendingItemIDs.add(id);
          }
        }
      }
    }
    else if (type == "collection") {
      if (event == "delete") {
        // The collection is gone and so is the list of what was in it, so recheck every
        // item that has tags from the plugin
        this.pendingFullSync = true;
      }
      else {
        // add, modify (rename, move to another parent, trash/restore), trash, restore...
        for (const id of ids) {
          this.pendingCollectionIDs.add(id);
        }
      }
    }
    this.scheduleFlush();
  },

  // Items in the given collections and all their subcollections, including trashed ones,
  // since a rename or move of a parent can change the tags of items in subcollections.
  // Queries the database directly because collection contents aren't necessarily loaded
  // into memory yet.
  async getCollectionItemIDs(collectionIDs) {
    const itemIDs = [];
    const ids = [...collectionIDs];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const sql = "WITH RECURSIVE tree(collectionID) AS ("
        + "SELECT collectionID FROM collections WHERE collectionID IN ("
        + chunk.map(() => "?").join(",") + ") "
        + "UNION SELECT C.collectionID FROM collections C "
        + "JOIN tree T ON C.parentCollectionID = T.collectionID) "
        + "SELECT DISTINCT itemID FROM collectionItems "
        + "WHERE collectionID IN (SELECT collectionID FROM tree)";
      itemIDs.push(...(await Zotero.DB.columnQueryAsync(sql, chunk) || []));
    }
    return itemIDs;
  },

  async getLibraryCollectionItemIDs(libraryID) {
    const sql = "SELECT DISTINCT itemID FROM collectionItems "
      + "JOIN collections USING (collectionID) WHERE libraryID=?";
    return (await Zotero.DB.columnQueryAsync(sql, libraryID)) || [];
  },

  scheduleFlush() {
    if (this.flushScheduled || this.shuttingDown) {
      return;
    }
    this.flushScheduled = true;
    // Wait briefly so a burst of events (dragging 500 items, renaming a big collection)
    // is handled in one pass
    Zotero.Promise.delay(this.EVENT_DELAY).then(() => {
      this.flushScheduled = false;
      this.enqueue(() => this.flush());
    });
  },

  // Resolves once all pending event work is done
  async waitForIdle() {
    while (this.flushScheduled || this.pendingItemIDs.size || this.pendingCollectionIDs.size
        || this.pendingFullSync) {
      await Zotero.Promise.delay(100);
      await this.queue;
    }
    await this.queue;
  },

  // Run jobs one at a time so event handling and menu commands never overlap
  enqueue(job) {
    const run = this.queue.then(job);
    this.queue = run.catch((e) => Zotero.logError(e));
    return run;
  },

  async flush() {
    if (this.shuttingDown) {
      return;
    }
    const fullSync = this.pendingFullSync;
    const itemIDs = [...this.pendingItemIDs];
    const collectionIDs = [...this.pendingCollectionIDs];
    this.pendingFullSync = false;
    this.pendingItemIDs.clear();
    this.pendingCollectionIDs.clear();
    if (fullSync) {
      await this.syncAll({ adopt: false });
      return;
    }
    if (collectionIDs.length) {
      itemIDs.push(...(await this.getCollectionItemIDs(collectionIDs)));
    }
    if (itemIDs.length) {
      await this.syncItems(itemIDs, { adopt: false });
    }
    await this.saveState();
  },

  onPrefChanged(name) {
    // Turning automatic syncing back on, or changing what gets tagged, needs every item
    // rechecked
    if (this.shuttingDown || !this.getPref("autoSync")) {
      return;
    }
    this.log(name + " changed, rechecking all items");
    this.pendingFullSync = true;
    this.scheduleFlush();
  },

  // ---------------------------------------------------------------------------------------
  // Syncing
  // ---------------------------------------------------------------------------------------

  isEditableLibrary(libraryID) {
    const library = Zotero.Libraries.get(libraryID);
    return !!library
      && (library.libraryType == "user" || library.libraryType == "group")
      && library.editable;
  },

  // Tag names an item should have, based on the collections it is in now
  getDesiredTags(item) {
    const names = new Set();
    if (item.isAnnotation()) {
      return names;
    }
    let source = item;
    if (!item.isTopLevelItem()) {
      if (!this.getPref("tagChildItems")) {
        return names;
      }
      source = item.parentItem;
      if (!source) {
        return names;
      }
    }
    const includeParents = this.getPref("includeParents");
    // getCollections() leaves out collections in the trash (a trashed parent collection
    // also trashes its subcollections)
    for (const collectionID of source.getCollections()) {
      let collection = Zotero.Collections.get(collectionID);
      while (collection) {
        const name = collection.name.trim();
        if (name) {
          names.add(name);
        }
        if (!includeParents || !collection.parentID) {
          break;
        }
        collection = Zotero.Collections.get(collection.parentID);
      }
    }
    return names;
  },

  // Works out the tag changes for one item and records them in this.managed.
  // Returns true if the item needs saving.
  updateItemTags(item, { adopt }) {
    const key = this.stateKey(item.libraryID, item.key);
    const desired = this.getDesiredTags(item);
    const existing = new Map(item.getTags().map((t) => [t.tag, t.type || 0]));
    const managed = new Set(this.managed.get(key) || []);
    let changed = false;

    // Tags the plugin added that were since removed by hand are no longer ours to manage
    for (const name of managed) {
      if (!existing.has(name)) {
        managed.delete(name);
      }
    }

    if (this.getPref("removeTags")) {
      for (const name of managed) {
        if (!desired.has(name)) {
          item.removeTag(name);
          managed.delete(name);
          changed = true;
        }
      }
    }

    for (const name of desired) {
      if (!existing.has(name)) {
        item.addTag(name, this.TAG_TYPE);
        managed.add(name);
        changed = true;
      }
      // An automatic tag with the collection's name already on the item was most likely
      // added by an earlier version of this plugin, so take it over during a full sync
      else if (adopt && existing.get(name) == this.TAG_TYPE) {
        managed.add(name);
      }
    }

    const before = this.managed.get(key);
    const same = before && before.size == managed.size && [...managed].every((n) => before.has(n));
    if (!same && (before || managed.size)) {
      if (managed.size) {
        this.managed.set(key, managed);
      }
      else {
        this.managed.delete(key);
      }
      this.stateDirty = true;
    }
    return changed;
  },

  // Syncs the given items (and their child attachments and notes).
  // Returns the number of items whose tags changed.
  async syncItems(itemIDs, { adopt = false, onProgress } = {}) {
    let items = (await Zotero.Items.getAsync([...new Set(itemIDs)])).filter(
      (item) => item && !item.isAnnotation() && this.isEditableLibrary(item.libraryID),
    );
    if (!items.length) {
      return 0;
    }
    await Zotero.Items.loadDataTypes(items, ["primaryData", "tags", "collections", "childItems"]);

    // Children inherit their parent's tags, so whenever a parent changes, so may they
    const ids = new Set(items.map((item) => item.id));
    const children = [];
    for (const item of items) {
      if (item.isRegularItem()) {
        for (const childID of [...item.getAttachments(true), ...item.getNotes(true)]) {
          if (!ids.has(childID)) {
            ids.add(childID);
            children.push(childID);
          }
        }
      }
    }
    if (children.length) {
      const childItems = await Zotero.Items.getAsync(children);
      await Zotero.Items.loadDataTypes(childItems, ["primaryData", "tags", "collections", "childItems"]);
      items = items.concat(childItems);
    }
    // Parents of child items are needed to work out the child's tags
    const parentIDs = items.filter((item) => item.parentItemID).map((item) => item.parentItemID);
    if (parentIDs.length) {
      await Zotero.Items.loadDataTypes(
        await Zotero.Items.getAsync([...new Set(parentIDs)]),
        ["primaryData", "collections"],
      );
    }

    let changedCount = 0;
    for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
      const batch = items.slice(i, i + this.BATCH_SIZE);
      const toSave = [];
      for (const item of batch) {
        try {
          if (this.updateItemTags(item, { adopt })) {
            toSave.push(item);
          }
        }
        catch (e) {
          Zotero.logError(e);
        }
      }
      if (toSave.length) {
        try {
          await Zotero.DB.executeTransaction(async () => {
            for (const item of toSave) {
              await item.save({ skipDateModifiedUpdate: true });
            }
          });
          changedCount += toSave.length;
        }
        catch (e) {
          Zotero.logError(e);
          // Undo unsaved changes so they don't get saved later along with something else
          for (const item of toSave) {
            if (item.hasChanged()) {
              await item.reload(["tags"], true);
            }
          }
        }
      }
      if (onProgress) {
        onProgress(Math.min(i + this.BATCH_SIZE, items.length), items.length);
      }
    }
    return changedCount;
  },

  async syncAll({ adopt, onProgress } = {}) {
    const itemIDs = new Set();
    for (const library of Zotero.Libraries.getAll()) {
      if (!this.isEditableLibrary(library.libraryID)) {
        continue;
      }
      for (const itemID of await this.getLibraryCollectionItemIDs(library.libraryID)) {
        itemIDs.add(itemID);
      }
    }
    // Items with tags from the plugin that may no longer be in any collection
    for (const key of [...this.managed.keys()]) {
      const [libraryID, itemKey] = key.split("/");
      const itemID = Zotero.Items.getIDFromLibraryAndKey(parseInt(libraryID), itemKey);
      if (itemID) {
        itemIDs.add(itemID);
      }
      else {
        this.managed.delete(key);
        this.stateDirty = true;
      }
    }
    const changed = await this.syncItems([...itemIDs], { adopt, onProgress });
    await this.saveState();
    return changed;
  },

  // ---------------------------------------------------------------------------------------
  // Menu commands
  // ---------------------------------------------------------------------------------------

  runFullSync() {
    // Drop any pending event work; the full sync covers it
    this.pendingItemIDs.clear();
    this.pendingCollectionIDs.clear();
    this.pendingFullSync = false;
    const progress = this.showProgress("Syncing collection tags…");
    return this.enqueue(async () => {
      try {
        const changed = await this.syncAll({
          adopt: true,
          onProgress: (done, total) => progress.update(done, total),
        });
        progress.finish(changed ? `Updated tags on ${changed} item(s).` : "All collection tags are up to date.");
        return changed;
      }
      catch (e) {
        progress.finish("Syncing collection tags failed. See Help → Debug Output Logging.");
        throw e;
      }
    });
  },

  runRemoveAll({ window } = {}) {
    const count = this.managed.size;
    const ok = Services.prompt.confirm(
      window || null,
      "Remove Collection Tags",
      `Remove the collection tags this plugin added to ${count} item(s)?\n\n`
        + "Tags you added yourself are not affected. Automatic syncing will be turned off "
        + "so the tags aren't added back; turn it on again in Settings → Add Collection Tag.",
    );
    if (!ok) {
      return Promise.resolve(0);
    }
    // Turn it off before removing so pref observers and events don't race with us
    this.setPref("autoSync", false);
    this.pendingItemIDs.clear();
    this.pendingCollectionIDs.clear();
    this.pendingFullSync = false;
    const progress = this.showProgress("Removing collection tags…");
    return this.enqueue(async () => {
      const removed = await this.removeAllTags({
        onProgress: (done, total) => progress.update(done, total),
      });
      progress.finish(`Removed collection tags from ${removed} item(s).`);
      return removed;
    });
  },

  async removeAllTags({ onProgress } = {}) {
    const entries = [...this.managed.entries()];
    let removed = 0;
    for (let i = 0; i < entries.length; i += this.BATCH_SIZE) {
      const batch = entries.slice(i, i + this.BATCH_SIZE);
      const toSave = [];
      for (const [key, tags] of batch) {
        const [libraryID, itemKey] = key.split("/");
        const item = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libraryID), itemKey);
        this.managed.delete(key);
        this.stateDirty = true;
        if (!item || !this.isEditableLibrary(item.libraryID)) {
          continue;
        }
        await Zotero.Items.loadDataTypes([item], ["primaryData", "tags"]);
        let changed = false;
        for (const name of tags) {
          changed = item.removeTag(name) || changed;
        }
        if (changed) {
          toSave.push(item);
        }
      }
      if (toSave.length) {
        await Zotero.DB.executeTransaction(async () => {
          for (const item of toSave) {
            await item.save({ skipDateModifiedUpdate: true });
          }
        });
        removed += toSave.length;
      }
      if (onProgress) {
        onProgress(Math.min(i + this.BATCH_SIZE, entries.length), entries.length);
      }
    }
    await this.saveState();
    return removed;
  },

  showProgress(headline) {
    let window;
    let line;
    try {
      window = new Zotero.ProgressWindow({ closeOnClick: true });
      window.changeHeadline(headline);
      line = new window.ItemProgress(null, "");
      window.show();
    }
    catch (e) {
      // No main window (e.g. while Zotero is starting or closing)
      window = null;
    }
    return {
      update(done, total) {
        if (line) {
          line.setText(`${done} / ${total} items checked`);
          line.setProgress(total ? Math.round((done / total) * 100) : 100);
        }
      },
      finish(text) {
        if (line) {
          line.setText(text);
          line.setProgress(100);
        }
        if (window) {
          window.startCloseTimer(4000);
        }
      },
    };
  },
};
