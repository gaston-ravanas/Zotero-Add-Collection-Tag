// Keep tags in sync automatically when items or collections change
pref("extensions.addcollectiontag.autoSync", true);
// Also tag items with the names of parent collections ("Parent" for an item in "Parent › Child")
pref("extensions.addcollectiontag.includeParents", true);
// Also tag child attachments and notes with their parent item's collection names
pref("extensions.addcollectiontag.tagChildItems", true);
// Remove a tag when its item leaves the collection (or the collection is renamed/deleted)
pref("extensions.addcollectiontag.removeTags", true);
