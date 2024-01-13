import { FetchState, IMGFetcher } from "../img-fetcher";
import { conf } from "../config";
import { evLog } from "../utils/ev-log";
import { i18n } from "../utils/i18n";
import { IMGFetcherQueue } from "../fetcher-queue";
import { IdleLoader } from "../idle-loader";
import JSZip from "jszip";
import saveAs from "file-saver";
import { Matcher } from "../platform/platform";
import { GalleryMeta } from "./gallery-meta";
import { Elements } from "../ui/html";

const FILENAME_INVALIDCHAR = /[\\/:*?"<>|]/g;
export class Downloader {
  meta: () => GalleryMeta;
  zip: JSZip;
  downloading: boolean;
  downloadForceElement?: HTMLElement;
  downloadStartElement?: HTMLAnchorElement;
  downloadNoticeElement?: HTMLElement;
  downloaderPlaneBTN: HTMLElement;
  queue: IMGFetcherQueue;
  added: Set<number> = new Set();
  idleLoader: IdleLoader;
  numberTitle: boolean | undefined;
  delayedQueue: { index: number, fetcher: IMGFetcher }[] = [];
  done: boolean = false;
  isReady: () => boolean;

  constructor(HTML: Elements, queue: IMGFetcherQueue, idleLoader: IdleLoader, matcher: Matcher, allPagesReady: () => boolean) {
    this.queue = queue;
    this.idleLoader = idleLoader;
    this.isReady = allPagesReady;
    this.meta = () => matcher.parseGalleryMeta(document);
    this.zip = new JSZip();
    this.downloading = false;
    this.downloadForceElement = document.querySelector("#download-force") || undefined;
    this.downloadStartElement = document.querySelector("#download-start") || undefined;
    this.downloadNoticeElement = document.querySelector("#download-notice") || undefined;
    this.downloaderPlaneBTN = HTML.downloaderPlaneBTN;
    this.downloadForceElement?.addEventListener("click", () => this.download());
    this.downloadStartElement?.addEventListener("click", () => this.start());
    this.queue.subscribeOnDo(0, () => this.downloading);
    this.queue.subscribeOnFinishedReport(0, (index, queue) => {
      if (this.added.has(index)) {
        return false;
      }
      this.added.add(index);
      this.addToDelayedQueue(index, queue[index]);
      if (queue.isFinised()) {
        if (this.downloading) {
          this.download();
        } else if (!this.done && this.downloaderPlaneBTN.style.color !== "lightgreen") {
          this.downloaderPlaneBTN.style.color = "lightgreen";
          if (!/✓/.test(this.downloaderPlaneBTN.textContent!)) {
            this.downloaderPlaneBTN.textContent += "✓";
          }
        }
      }
      return false;
    });
  }

  needNumberTitle(): boolean {
    if (this.numberTitle !== undefined) {
      return this.numberTitle;
    } else {
      this.numberTitle = false;
      let lastTitle = "";
      for (const fetcher of this.queue) {
        if (fetcher.title < lastTitle) {
          this.numberTitle = true;
          break;
        }
        lastTitle = fetcher.title;
      }
      return this.numberTitle!;
    }
  }

  addToDelayedQueue(index: number, imgFetcher: IMGFetcher) {
    if (this.isReady()) {
      if (this.delayedQueue.length > 0) {
        for (const item of this.delayedQueue) {
          this.addToDownloadZip(item.index, item.fetcher);
        }
        this.delayedQueue = [];
      }
      this.addToDownloadZip(index, imgFetcher);
    } else {
      this.delayedQueue.push({ index, fetcher: imgFetcher });
    }
  }

  addToDownloadZip(index: number, imgFetcher: IMGFetcher) {
    if (!imgFetcher.blobData) {
      evLog("无法获取图片数据，因此该图片无法下载");
      return;
    }
    let title = imgFetcher.title;
    if (this.needNumberTitle()) {
      const digit = this.queue.length.toString().length;
      title = conf.filenameTemplate
        .replace("{number}", (index + 1).toString().padStart(digit, "0"))
        .replace("{title}", title);
    }
    this.zip.file(this.checkDuplicateTitle(index, title), imgFetcher.blobData, { binary: true });
    imgFetcher.blobData = undefined;
  }

  checkDuplicateTitle(index: number, $title: string): string {
    let newTitle = $title.replace(FILENAME_INVALIDCHAR, "_");
    if (this.zip.files[newTitle]) {
      let splits = newTitle.split(".");
      const ext = splits.pop();
      const prefix = splits.join(".");
      const num = parseInt(prefix.match(/_(\d+)$/)?.[1] || "");
      if (isNaN(num)) {
        newTitle = `${prefix}_1.${ext}`;
      } else {
        newTitle = `${prefix.replace(/\d+$/, (num + 1).toString())}.${ext}`;
      }
      return this.checkDuplicateTitle(index, newTitle);
    } else {
      return newTitle;
    }
  }

  // check > start > download
  check() {
    if (conf.fetchOriginal) return;
    // append adviser element
    if (this.downloadNoticeElement && !this.downloading) {
      this.downloadNoticeElement.innerHTML = `<span>${i18n.originalCheck.get()}</span>`;
      this.downloadNoticeElement.querySelector("a")?.addEventListener("click", () => this.fetchOriginalTemporarily());
    }
  }

  fetchOriginalTemporarily() {
    conf.fetchOriginal = true; // May result in incorrect persistence of the conf
    this.queue.forEach(imgFetcher => {
      imgFetcher.stage = FetchState.URL;
    });
    this.start();
  }

  start() {
    if (this.queue.isFinised()) {
      this.download();
      return;
    }
    this.flushUI("downloading")
    this.downloading = true;
    // Temporary enable "autoload", but it may result in persisting this to the config.
    conf.autoLoad = true;

    // reset img fetcher stage to url, if it's failed
    this.queue.forEach((imf) => {
      if (imf.stage === FetchState.FAILED) {
        imf.retry();
      }
    });
    // find all of unloading imgFetcher and splice frist few imgFetchers
    this.idleLoader.processingIndexList = this.queue.map((imgFetcher, index) => (!imgFetcher.lock && imgFetcher.stage === FetchState.URL ? index : -1))
      .filter((index) => index >= 0)
      .splice(0, conf.downloadThreads);
    this.idleLoader.onFailed(() => {
      this.downloading = false;
      this.flushUI("downloadFailed")
    });
    this.idleLoader.start(++this.idleLoader.lockVer);
  }

  flushUI(stage: "downloadFailed" | "downloaded" | "downloading" | "downloadStart") {
    if (this.downloadNoticeElement) {
      this.downloadNoticeElement.innerHTML = `<span>${i18n[stage].get()}</span>`;
    }
    if (this.downloadStartElement) {
      this.downloadStartElement.style.color = stage === "downloadFailed" ? "red" : "";
      this.downloadStartElement.textContent = i18n[stage].get();
    }
    this.downloaderPlaneBTN.style.color = stage === "downloadFailed" ? "red" : "";
  }

  download() {
    this.downloading = false;
    this.idleLoader.abort(this.queue.currIndex);
    if (this.delayedQueue.length > 0) {
      for (const item of this.delayedQueue) {
        this.addToDownloadZip(item.index, item.fetcher);
      }
      this.delayedQueue = [];
    }
    const meta = this.meta();
    this.zip.file("meta.json", JSON.stringify(meta));
    // TODO: find a way to unlimited the size of zip file
    // https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle
    this.zip.generateAsync({ type: "blob" }, (_metadata) => {
      // console.log(metadata);
      // TODO: progress bar
    }).then(data => {
      saveAs(data, `${meta.originTitle || meta.title}.zip`);
      this.flushUI("downloaded");
      this.done = true;
      this.downloaderPlaneBTN.textContent = i18n.download.get();
      this.downloaderPlaneBTN.style.color = "";
    });
  };
}

