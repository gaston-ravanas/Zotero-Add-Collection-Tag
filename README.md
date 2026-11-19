# Zotero extension - Add Collection Tag

Automatically tags every item with the name of each collection or sub-collection it is in, and keeps those tags in sync as your library changes.

This is a fork of [Zar-rok/Zotero-Add-Collection-Tag](https://github.com/Zar-rok/Zotero-Add-Collection-Tag) (MIT license), rewritten for Zotero 7–10. It has its own plugin ID, so it installs and updates separately from the original.

## Example

```
My Library:
|_Collection 1
  |_Item A          -> tag "Collection 1"
  |_Sub-collection
    |_Item B        -> tags "Sub-collection" and "Collection 1"
      |_B.pdf       -> same tags as Item B
```

## What keeps the tags in sync

| You do this                                                        | The plugin does this                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Save an item with the Zotero Connector, import, or create an item in a collection | Adds the collection tag                     |
| Change the target collection in the Connector popup after saving   | Swaps the tag                                                |
| Add an item to another collection (drag and drop)                  | Adds that collection's tag too                               |
| Move an item to another collection, or remove it from one          | Removes the old collection's tag                             |
| Rename a collection                                                | Renames the tag on every item in it (and in its sub-collections when parent tags are on) |
| Move a sub-collection under another parent                         | Updates parent-collection tags (when parent tags are on)    |
| Move a collection to the trash / restore it                        | Removes / re-adds the tags                                   |
| Delete a collection permanently                                    | Removes the tags                                             |
| Add a PDF, snapshot or note to an item, or move it to another item | Gives it its parent item's tags                              |
| Merge duplicates                                                   | The merged item gets the tags of all its collections         |

Other details:

- **Your own tags are safe.** The plugin only removes tags it added itself. A tag you typed, or a keyword imported with the item, is never removed, even if it has the same name as a collection.
- An item in two collections with the same name keeps the tag until it leaves both.
- Tags are added as automatic tags (shown in orange in the tag selector).
- PDF annotations are never tagged.
- Read-only group libraries and feeds are left alone.
- Tagging doesn't change an item's "Date Modified".

## Tagging items already in your library

Use **Tools → Sync Collection Tags**. This tags every item in your collections and fixes any tags that are out of date. Run it once after installing. It's also safe to run again at any time.

If you used an earlier version of this plugin, its tags are taken over by the first sync, so they'll be kept up to date from then on.

To undo everything, use **Tools → Remove Collection Tags…**. It removes only the tags the plugin added, and turns off automatic syncing.

## Settings

In **Zotero Settings → Add Collection Tag**:

- **Keep tags in sync automatically** (on): turn off to only tag when you use Tools → Sync Collection Tags. Turning it back on catches up straight away.
- **Remove the tag when an item leaves a collection…** (on): turn off to keep collection tags as a history. Renaming a collection then keeps both the old and new name.
- **Also add the names of parent collections** (on): an item in `Parent › Child` gets both `Child` and `Parent` as separate tags.
- **Also tag attachments and notes** (on).

Changing a setting updates your existing items straight away.

## How it remembers which tags it added

The list is stored in `add-collection-tag.json` in your Zotero data directory. If that file is lost, nothing breaks: the next Tools → Sync Collection Tags rebuilds it from the collection tags already on your items.

This list isn't synced between computers. If you use Zotero on several computers, install the plugin on each one and run Tools → Sync Collection Tags once on each.

## Compatibility

Zotero 7, 8, 9 and 10. Zotero 6 and earlier are not supported.

## Installation

1. Download the `.xpi` file from the [latest release](https://github.com/gaston-ravanas/Zotero-Add-Collection-Tag/releases/latest).
2. In Zotero, open Tools → Plugins, click the gear icon, and choose "Install Plugin From File…".

After that, Zotero updates the plugin automatically whenever a new release is published. It checks about once a day. To check now, use the gear icon in Tools → Plugins → "Check for Updates".

## Development

Build locally with `./build.sh`. It writes `build/zotero-add-collection-tag-<version>.xpi` and `build/updates.json`.

To publish a new version:

1. Bump `"version"` in `manifest.json` (and `strict_max_version` when a new Zotero major version has been tested).
2. Commit, then tag and push:

   ```sh
   git commit -am "Release 0.3.1"
   git tag v0.3.1
   git push origin master v0.3.1
   ```

3. The [Release workflow](.github/workflows/release.yml) builds the plugin and publishes a GitHub Release containing the `.xpi` and `updates.json`. Installed copies pick it up through the `update_url` in `manifest.json`, which points to `releases/latest/download/updates.json`.

The tag must match the version in `manifest.json`, or the workflow stops without publishing.
