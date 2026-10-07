/**
 * What every module needs to know about a capture regardless of where it came from:
 * a browser, an Android device, an iOS simulator or a folder of screenshots.
 */

/** Whether a capture is of an app rather than a website. */
export function isNative(platform) {
  return Boolean(platform) && platform !== "web";
}

/** The words for what was captured: pages of a site, or screens of an app. */
export function nouns(platform) {
  const native = isNative(platform);
  return { item: native ? "screen" : "page", items: native ? "screens" : "pages", whole: native ? "app" : "site" };
}

/**
 * The images of a shot beyond its first screen, labelled for the critic: the
 * full-page capture of a web page, or the further scroll frames of an app screen
 * (the first frame is the first screen, which the critic already has).
 */
export function detailImages(shot) {
  if (Array.isArray(shot.frames) && shot.frames.length) {
    return shot.frames.slice(1).map((file, i) => ({ file, label: `scrolled down, frame ${i + 2} of ${shot.frames.length}` }));
  }
  if (shot.full) return [{ file: shot.full, label: "full page" }];
  return [];
}

/** Every image of a shot, first screen first, for a before and after comparison. */
export function allImages(shot) {
  return [{ file: shot.fold, label: "first screen" }, ...detailImages(shot)];
}
