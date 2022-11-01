// ==UserScript==
// @name         E-HENTAI-VIEW-ENHANCE
// @namespace    https://github.com/kamo2020/eh-view-enhance
// @version      3.0.0
// @description  强化E绅士看图体验
// @author       kamo2020
// @match        https://exhentai.org/g/*
// @match        https://e-hentai.org/g/*
// @connect      hath.network
// @icon         https://exhentai.org/favicon.ico
// @grant        GM.xmlHttpRequest
// @require     https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require     https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.0/FileSaver.min.js
// ==/UserScript==

const regulars = {
  // 有压缩的大图地址
  normal: /\<img\sid=\"img\"\ssrc=\"(.*?)\"\sstyle/,
  // 原图地址
  original: /\<a\shref=\"(http[s]?:\/\/e[x-]?hentai\.org\/fullimg\.php\?[^"\\]*)\"\>/,
  // 大图重载地址
  nlValue: /\<a\shref=\"\#\"\sid=\"loadfail\"\sonclick=\"return\snl\(\'(.*)\'\)\"\>/,
  // 是否开启自动多页查看器
  isMPV: /https?:\/\/e[-x]hentai.org\/mpv\/\w+\/\w+\/#page\w/,
  // 多页查看器图片列表提取
  mpvImageList: /\{"n":"(.*?)","k":"(\w+)","t":"(.*?)".*?\}/g,
};

//==================面向对象，图片获取器IMGFetcher，图片获取器调用队列IMGFetcherQueue=====================START
class IMGFetcher {
  constructor(node) {
    this.node = node;
    this.imgElement = node.childNodes[0];
    this.pageUrl = this.imgElement.getAttribute("ahref");
    //当前处理阶段，1: 获取大图地址 2: 获取大图数据 3: 加载完成
    this.stage = 1;
    this.tryTime = 0;
    this.lock = false;
    this.rendered = false;
    this.blobData = undefined;
    this.title = this.imgElement.getAttribute("title");
    /**
     * 下载状态
     * total: 图片数据量
     * loaded: 已下载的数据量
     * readyState: 0未开始下载; 1-3下载中; 4下载完毕
     * rate:下载速率
     */
    this.downloadState = { total: 100, loaded: 0, readyState: 0, rate: 0 };
    /**
     * 当获取完成时的回调函数，从其他地方进行事件注册
     */
    this.onFinishedEventContext = new Map();
    this.fetchOriginal = false;
  }

  // 刷新下载状态
  setDownloadState(newDLState) {
    const increased = (newDLState.loaded || 0) - this.downloadState.loaded;
    this.downloadState.rate = increased;
    this.downloadState = { ...this.downloadState, ...newDLState };
    if (this.downloadState.readyState === 4) {
      if (this.downloadBar) {
        this.downloadBar.remove();
      }
      return;
    }
    if (!this.downloadBar) {
      this.downloadBar = document.createElement("div");
      this.downloadBar.classList.add("downloadBar");
      this.downloadBar.innerHTML = `
      <progress style="position: absolute; width: 100%; height: 10px;" value="0" max="100" />
      `;
      this.node.appendChild(this.downloadBar);
    }
    [...this.downloadBar.childNodes].filter((node) => node.nodeType === 1)[0].value = (this.downloadState.loaded / this.downloadState.total) * 100;
    downloaderCanvas.drawDebouce();
  }

  async start(index) {
    if (this.lock) return;
    this.lock = true;
    try {
      this.changeStyle("add");
      if (!(await this.fetchImg())) {
        throw new Error("图片获取器失败，中止获取！");
      }
      this.changeStyle("remove", "success");
    } catch (error) {
      this.changeStyle("remove", "failed");
      evLog(`图片获取器获取失败:`, error);
    } finally {
      this.lock = false;
      this.onFinishedEventContext.forEach((callback) => callback(index, this));
    }
  }

  onFinished(eventId, callback) {
    this.onFinishedEventContext.set(eventId, callback);
  }

  async fetchImg() {
    switch (this.stage) {
      case 1:
        return await this.stage1FetchUrl();
      case 2:
        return await this.stage2FetchImg();
      case 3:
        return this.stage3Done();
    }
  }

  // 阶段一：获取大图的地址
  async stage1FetchUrl() {
    try {
      this.changeStyle("add");
      if (!(await this.fetchBigImageUrl())) {
        evLog("获取大图地址失败");
        return false;
      }
      //成功获取到大图的地址后，将本图片获取器的状态修改为1，表示大图地址已经成功获取到
      if (!this.bigImageUrl) {
        evLog("大图地址不存在！");
        return false;
      }
      this.stage = 2;
      return this.fetchImg();
    } catch (error) {
      evLog(`获取大图地址时出现了异常:`, error);
      return false;
    }
  }
  // 阶段二：获取大图数据
  async stage2FetchImg() {
    this.setDownloadState(this.downloadState);
    try {
      if (!(await this.fetchBigImage())) {
        throw new Error(`获取大图数据失败,大图地址:${this.bigImageUrl}`);
      }
      this.stage = 3;
      return this.fetchImg();
    } catch (error) {
      evLog(`获取大图数据时出现了异常:`, error);
      //如果失败了，则进行重试，重试会进行2次
      ++this.tryTime;
      this.stage = 1;
      // 重试2次后，直接失败，避免无限请求
      evLog(`当前重试第${this.tryTime}次`);
      if (this.tryTime > 2) {
        return false;
      }
      return this.fetchImg();
    }
  }
  // 阶段三：获取器结束
  stage3Done() {
    this.rendered = false;
    this.render();
    return true;
  }

  //被滚动事件触发
  //被获取大图数据成功时触发
  render() {
    if (this.stage === 3) {
      if (this.rendered) return;
      // this.imgElement.style.height = "auto";
      this.imgElement.src = this.blobUrl;
      this.rendered = true;
    } else {
      if (this.rendered) return;
      // this.imgElement.style.height = "auto";
      this.imgElement.src = this.imgElement.getAttribute("asrc");
      this.rendered = true;
    }
  }

  //立刻将当前元素的src赋值给大图元素
  setNow(index) {
    if (this.stage === 3) {
      this.onFinishedEventContext.forEach((callback) => callback(index, this));
    } else {
      bigImageElement.src = this.imgElement.getAttribute("asrc");
      pageHandler("fetching");
    }
    pageHandler("updateCurrPage", index + 1);
  }

  /**
   *  获取大图地址
   * @param {是否为重新换源状态，为true时，不再进行新的换源动作，避免无限递归} changeOrigin
   * @returns
   */
  async fetchBigImageUrl(changeOrigin) {
    const imgFetcher = this;
    return new Promise(async (resolve) => {
      const onload = (response) => {
        const text = response.response;
        if (!(typeof text === "string")) {
          evLog("未获取到有效的文档！", response);
          resolve(false);
          return;
        }
        //抽取最佳质量的图片的地址
        if (conf["fetchOriginal"] || imgFetcher.fetchOriginal) {
          const matchs = regulars["original"].exec(text);
          if (matchs == null || matchs.length < 1) {
            const normalMatchs = regulars["normal"].exec(text);
            if (normalMatchs == null || normalMatchs.length == 0) {
              evLog("获取大图地址失败，内容为: ", text);
            } else {
              imgFetcher.bigImageUrl = normalMatchs[1];
            }
          } else {
            imgFetcher.bigImageUrl = matchs[1].replace(/&amp;/g, "&");
          }
        }
        //抽取正常的有压缩的大图地址
        else if (imgFetcher.tryTime === 0 || changeOrigin) {
          imgFetcher.bigImageUrl = regulars["normal"].exec(text)[1];
        }
        //如果是重试状态,则进行换源
        else {
          const nlValue = regulars["nlValue"].exec(text)[1];
          imgFetcher.pageUrl += ((imgFetcher.pageUrl + "").indexOf("?") > -1 ? "&" : "?") + "nl=" + nlValue;
          evLog(`获取到重试地址:${imgFetcher.pageUrl}`);
          imgFetcher
            .fetchBigImageUrl(true)
            .then((ok) => resolve(ok))
            .catch(() => resolve(false));
          return;
        }
        resolve(true);
      };
      xhrWapper(imgFetcher.pageUrl, imgFetcher.pageUrl, "text", { onload, onerror: () => resolve(false), ontimeout: () => resolve(false) });
    });
  }

  async fetchBigImage() {
    const imgFetcher = this;
    return new Promise(async (resolve) => {
      xhrWapper(imgFetcher.bigImageUrl, imgFetcher.bigImageUrl, "blob", {
        onload: function (response) {
          let data = response.response;
          if (!(data instanceof Blob)) throw new Error("未下载到有效的数据！");
          imgFetcher.blobData = data;
          imgFetcher.blobUrl = URL.createObjectURL(data);
          imgFetcher.setDownloadState({ total: response.total, loaded: response.loaded, readyState: response.readyState });
          resolve(true);
        },
        onerror: function (response) {
          evLog("加载大图失败:", response);
          resolve(false);
        },
        ontimeout: function (response) {
          evLog("加载大图超时:", response);
          resolve(false);
        },
        onprogress: function (response) {
          imgFetcher.setDownloadState({ total: response.total, loaded: response.loaded, readyState: response.readyState });
        },
      });
    });
  }

  changeStyle(action, fetchStatus) {
    if (action === "remove") {
      //当获取到内容，或者获取失败，则移除本缩略图的边框效果
      this.imgElement.classList.remove("fetching");
    } else if (action === "add") {
      //给当前缩略图元素添加一个获取中的边框样式
      this.imgElement.classList.add("fetching");
    }
    if (fetchStatus === "success") {
      this.imgElement.classList.add("fetched");
      this.imgElement.classList.remove("fetch-failed");
    } else if (fetchStatus === "failed") {
      this.imgElement.classList.add("fetch-failed");
      this.imgElement.classList.remove("fetched");
    }
  }
}

class IMGFetcherQueue extends Array {
  constructor() {
    super();
    //可执行队列
    this.executableQueue = [];
    //当前的显示的大图的图片请求器所在的索引
    this.currIndex = 0;
    //已经完成加载的
    this.finishedIndex = [];
    this.debouncer = new Debouncer();
  }

  isFinised() {
    return this.finishedIndex.length === this.length;
  }

  push(...IFs) {
    IFs.forEach((imgFetcher) => imgFetcher.onFinished("QUEUE-REPORT", (index) => this.finishedReport(index)));
    super.push(...IFs);
  }

  unshift(...IFs) {
    IFs.forEach((imgFetcher) => imgFetcher.onFinished("QUEUE-REPORT", (index) => this.finishedReport(index)));
    super.unshift(...IFs);
  }

  do(start, oriented) {
    oriented = oriented || "next";
    //边界约束
    this.currIndex = this.fixIndex(start, oriented);
    if (downloader.downloading) {
      //立即加载和展示当前的元素
      this[this.currIndex].setNow(this.currIndex);
      return;
    }
    //立即中止空闲加载器
    idleLoader.abort(this.currIndex);
    //立即加载和展示当前的元素
    this[this.currIndex].setNow(this.currIndex);

    //从当前索引开始往后,放入指定数量的图片获取器,如果该图片获取器已经获取完成则向后延伸.
    //如果最后放入的数量为0,说明已经没有可以继续执行的图片获取器,可能意味着后面所有的图片都已经加载完毕,也可能意味着中间出现了什么错误
    if (!this.pushInExecutableQueue(oriented)) return;

    /* 300毫秒的延迟，在这300毫秒的时间里，可执行队列executableQueue可能随时都会变更，100毫秒过后，只执行最新的可执行队列executableQueue中的图片请求器
            在对大图元素使用滚轮事件的时候，由于速度非常快，大量的IMGFetcher图片请求器被添加到executableQueue队列中，如果调用这些图片请求器请求大图，可能会被认为是爬虫脚本
            因此会有一个时间上的延迟，在这段时间里，executableQueue中的IMGFetcher图片请求器会不断更替，300毫秒结束后，只调用最新的executableQueue中的IMGFetcher图片请求器。
        */
    this.debouncer.addEvent("IFQ-EXECUTABLE", () => {
      this.executableQueue.forEach((imgFetcherIndex) => this[imgFetcherIndex].start(imgFetcherIndex));
    }, 300);
  }

  //等待图片获取器执行成功后的上报，如果该图片获取器上报自身所在的索引和执行队列的currIndex一致，则改变大图
  finishedReport(index) {
    const imgFetcher = this[index];
    if (downloader) {
      if (this.finishedIndex.indexOf(index) < 0) {
        downloader.addToDownloadZip(imgFetcher);
      }
    }
    this.pushFinishedIndex(index);
    if (downloader && downloader.downloading && this.isFinised()) {
      downloader.download();
    }
    pageHandler("updateFinished", this.finishedIndex.length);
    evLog(`第${index + 1}张完成，大图所在第${this.currIndex + 1}张`);
    if (index !== this.currIndex) return;
    if (!conf.keepScale) {
      //是否保留缩放
      bigImageElement.style.width = "100%";
      bigImageElement.style.height = "100%";
      bigImageElement.style.top = "0px";
    }
    pageHandler("fetched");
    bigImageElement.src = imgFetcher.blobUrl;
    this.scrollTo(index);
  }

  scrollTo(index) {
    const imgFetcher = this[index];
    let scrollTo = imgFetcher.node.offsetTop - window.screen.availHeight / 3;
    scrollTo = scrollTo <= 0 ? 0 : scrollTo >= fullViewPlane.scrollHeight ? fullViewPlane.scrollHeight : scrollTo;
    fullViewPlane.scrollTo({ top: scrollTo, behavior: "smooth" });
  }

  //如果开始的索引小于0,则修正索引为0,如果开始的索引超过队列的长度,则修正索引为队列的最后一位
  fixIndex(start) {
    return start < 0 ? 0 : start > this.length - 1 ? this.length - 1 : start;
  }

  /**
   * 将方向前|后 的未加载大图数据的图片获取器放入待加载队列中
   * 从当前索引开始，向后或向前进行遍历，
   * 会跳过已经加载完毕的图片获取器，
   * 会添加正在获取大图数据或未获取大图数据的图片获取器到待加载队列中
   * @param {方向 前后} oriented
   * @returns 是否添加成功
   */
  pushInExecutableQueue(oriented) {
    //把要执行获取器先放置到队列中，延迟执行
    this.executableQueue = [];
    for (let count = 0, index = this.currIndex; this.pushExecQueueSlave(index, oriented, count); oriented === "next" ? ++index : --index) {
      if (this[index].stage === 3) continue;
      this.executableQueue.push(index);
      count++;
    }
    return this.executableQueue.length > 0;
  }

  // 如果索引已到达边界且添加数量在配置最大同时获取数量的范围内
  pushExecQueueSlave(index, oriented, count) {
    return ((oriented === "next" && index < this.length) || (oriented === "prev" && index > -1)) && count < conf["threads"];
  }

  findIndex(imgElement) {
    for (let index = 0; index < this.length; index++) {
      if (this[index] instanceof IMGFetcher && this[index].imgElement === imgElement) {
        return index;
      }
    }
    return 0;
  }

  pushFinishedIndex(index) {
    const fd = this.finishedIndex;
    if (fd.length === 0) {
      fd.push(index);
      return;
    }
    for (let i = 0; i < fd.length; i++) {
      if (index === fd[i]) return;
      if (index < fd[i]) {
        fd.splice(i, 0, index);
        return;
      }
    }
    fd.push(index);
  }
}

//空闲自加载
class IdleLoader {
  constructor(IFQ) {
    //图片获取器队列
    this.queue = IFQ;
    //当前处理的索引列表
    this.processingIndexList = [0];
    this.lockVer = 0;
    //中止后的用于重新启动的延迟器的id
    this.restartId;
    this.maxWaitMS = 1000;
    this.minWaitMS = 300;
  }

  async start(lockVer) {
    evLog("空闲自加载启动:" + this.processingIndexList.toString());
    //如果被中止了，则停止
    if (this.lockVer != lockVer || !conf["autoLoad"]) return;
    // 如果已经没有要处理的列表
    if (this.processingIndexList.length === 0) {
      return;
    }
    for (let i = 0; i < this.processingIndexList.length; i++) {
      const processingIndex = this.processingIndexList[i];
      // 获取索引所对应的图片获取器，并添加完成事件，当图片获取完成时，重新查找新的可获取的图片获取器，并递归
      const imgFetcher = this.queue[processingIndex];
      // 当图片获取器还没有获取图片时，则启动图片获取器
      if (imgFetcher.lock || imgFetcher.stage === 3) {
        continue;
      }
      imgFetcher.onFinished("IDLE-REPORT", () => {
        this.wait().then(() => {
          this.checkProcessingIndex(i);
          this.start(lockVer);
        });
      });
      imgFetcher.start(processingIndex);
    }
  }

  /**
   * @param {当前处理列表中的位置} i
   */
  checkProcessingIndex(i) {
    const processedIndex = this.processingIndexList[i];
    let restart = false;
    // 从图片获取器队列中获取一个还未获取图片的获取器所对应的索引，如果不存在则从处理列表中删除该索引，缩减处理列表
    for (let j = processedIndex, max = this.queue.length - 1; j <= max; j++) {
      const imgFetcher = this.queue[j];
      // 如果图片获取器正在获取或者图片获取器已完成获取，
      if (imgFetcher.stage === 3 || imgFetcher.lock) {
        if (j === max && !restart) {
          j = -1;
          max = processedIndex - 1;
          restart = true;
        }
        continue;
      }
      this.processingIndexList[i] = j;
      return;
    }
    this.processingIndexList.splice(i, 1);
  }

  async wait() {
    const { maxWaitMS, minWaitMS } = this;
    return new Promise(function (resolve) {
      const time = Math.floor(Math.random() * maxWaitMS + minWaitMS);
      window.setTimeout(() => resolve(), time);
    });
  }

  abort(newIndex) {
    this.lockVer++;
    evLog(`终止空闲自加载, 下次将从第${this.processingIndexList[0] + 1}张开始加载`);
    if (!conf.autoLoad) return;
    // 中止空闲加载后，会在等待一段时间后再次重启空闲加载
    window.clearTimeout(this.restartId);
    this.restartId = window.setTimeout(() => {
      this.processingIndexList = [newIndex];
      this.checkProcessingIndex(0);
      this.start(this.lockVer);
    }, conf["restartIdleLoader"]);
  }
}

//页获取器，可获取下一个列表页，以及下一个图片页
class PageFetcher {
  constructor(IFQ, idleLoader) {
    this.queue = IFQ;
    //所有页的地址
    this.pageUrls = [];
    //当前页所在的索引
    this.currPage = 0;
    //每页的图片获取器列表，用于实现懒加载
    this.imgAppends = { prev: [], next: [] };
    //平均高度，用于渲染未加载的缩略图,单位px
    this.idleLoader = idleLoader;
    this.fetched = false;
  }

  async init() {
    this.initPageUrls();
    await this.initPageAppend();
    this.loadAllPageImg();
    this.renderCurrView(fullViewPlane.scrollTop, fullViewPlane.clientHeight);
  }

  initPageUrls() {
    const pager = document.querySelector(".gtb");
    if (!pager) {
      throw new Error("未获取到分页元素！");
    }
    const tds = pager.querySelectorAll("td");
    if (!tds || tds.length == 0) {
      throw new Error("未获取到有效的分页元素！");
    }
    const curr = [...tds].filter((p) => p.className.indexOf("ptds") != -1)[0];
    const currPageNum = PageFetcher.findPageNum(!curr ? "" : curr.firstElementChild.href);
    const lastPage = PageFetcher.findPageNum(tds[tds.length - 2].firstElementChild.href);
    const firstPageUrl = tds[1].firstElementChild.href;
    this.pageUrls.push(firstPageUrl);
    for (let i = 1; i <= lastPage; i++) {
      this.pageUrls.push(`${firstPageUrl}?p=${i}`);
      if (i == currPageNum) {
        this.currPage = i;
      }
    }
    evLog("所有页码地址加载完毕:", this.pageUrls);
  }

  async initPageAppend() {
    for (let i = 0; i < this.pageUrls.length; i++) {
      const pageUrl = this.pageUrls[i];
      if (i == this.currPage) {
        await this.appendDefaultPage(pageUrl);
      } else {
        const oriented = i < this.currPage ? "prev" : "next";
        this.imgAppends[oriented].push(async () => await this.appendPageImg(pageUrl, oriented));
      }
    }
  }

  async loadAllPageImg() {
    if (this.fetched) return;
    for (let i = 0; i < this.imgAppends["next"].length; i++) {
      const executor = this.imgAppends["next"][i];
      await executor();
    }
    for (let i = this.imgAppends["prev"].length - 1; i > -1; i--) {
      const executor = this.imgAppends["prev"][i];
      await executor();
    }
  }

  static findPageNum(pageUrl) {
    if (pageUrl) {
      const arr = pageUrl.split("?");
      if (arr && arr.length > 1) {
        return parseInt(/p=(\d*)/.exec(arr[1]).pop());
      }
    }
    return 0;
  }

  async appendDefaultPage(pageUrl) {
    const doc = await this.fetchDocument(pageUrl);
    const imgNodeList = await this.obtainImageNodeList(doc);
    const IFs = imgNodeList.map((imgNode) => new IMGFetcher(imgNode));
    fullViewPlane.firstElementChild.nextElementSibling.after(...imgNodeList);
    this.queue.push(...IFs);
    pageHandler("updateTotal", this.queue.length);
  }

  async appendPageImg(pageUrl, oriented) {
    try {
      const doc = await this.fetchDocument(pageUrl);
      const imgNodeList = await this.obtainImageNodeList(doc);
      const IFs = imgNodeList.map((imgNode) => new IMGFetcher(imgNode));
      switch (oriented) {
        case "prev":
          fullViewPlane.firstElementChild.nextElementSibling.after(...imgNodeList);
          this.queue.unshift(...IFs);
          this.idleLoader.processingIndexList[0] += IFs.length;
          this.queue.scrollTo(this.idleLoader.processingIndexList[0]);
          break;
        case "next":
          fullViewPlane.lastElementChild.after(...imgNodeList);
          this.queue.push(...IFs);
          break;
      }
      pageHandler("updateTotal", this.queue.length);
      return true;
    } catch (error) {
      evLog(`从下一页或上一页中提取图片元素时出现了错误！`, error);
      return false;
    }
  }

  //从文档的字符串中创建缩略图元素列表
  async obtainImageNodeList(docString) {
    const list = [];
    if (!docString) return list;
    const domParser = new DOMParser();
    const doc = domParser.parseFromString(docString, "text/html");
    const aNodes = doc.querySelectorAll("#gdt a");
    if (!aNodes || aNodes.length == 0) {
      evLog("wried to get a nodes from document, but failed!");
      return list;
    }
    const aNode = aNodes[0];

    // make node template
    const imgNodeTemplate = document.createElement("div");
    imgNodeTemplate.classList.add("img-node");
    const imgTemplate = document.createElement("img");
    imgTemplate.setAttribute("decoding", "async");
    imgTemplate.style.height = "auto";
    imgTemplate.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==");
    imgNodeTemplate.appendChild(imgTemplate);

    // MPV
    if (regulars.isMPV.test(aNode.href)) {
      const mpvDoc = await this.fetchDocument(aNode.href);
      const matchs = mpvDoc.matchAll(regulars.mpvImageList);
      const gid = location.pathname.split("/")[2];
      let i = 0;
      for (const match of matchs) {
        i++;
        const newImgNode = imgNodeTemplate.cloneNode(true);
        const newImg = newImgNode.firstChild;
        newImg.setAttribute("title", match[1]);
        newImg.setAttribute("ahref", `${location.origin}/s/${match[2]}/${gid}-${i}`);
        newImg.setAttribute("asrc", match[3].replaceAll("\\", ""));
        newImg.addEventListener("click", showBigImageEvent);
        list.push(newImgNode);
      }
      this.fetched = true;
    }
    // normal
    else {
      for (const aNode of aNodes) {
        const imgNode = aNode.querySelector("img");
        const newImgNode = imgNodeTemplate.cloneNode(true);
        const newImg = newImgNode.firstChild;
        newImg.setAttribute("ahref", aNode.href);
        newImg.setAttribute("asrc", imgNode.src);
        newImg.setAttribute("title", imgNode.getAttribute("title"));
        newImg.addEventListener("click", showBigImageEvent);
        list.push(newImgNode);
      }
    }
    return list;
  }

  //通过地址请求该页的文档
  async fetchDocument(pageUrl) {
    return await window.fetch(pageUrl).then((response) => response.text());
  }

  /**
   *当滚动停止时，检查当前显示的页面上的是什么元素，然后渲染图片
   * @param {当前滚动位置} currTop
   * @param {窗口高度} clientHeight
   */
  renderCurrView(currTop, clientHeight) {
    // 当前视图，即浏览器显示的内容、滚动到的区域
    // 当前视图上边位置
    const viewTop = currTop;
    // 当前视图下边位置
    const viewButtom = currTop + clientHeight;
    const colCount = conf["colCount"];
    const IFs = this.queue;
    let startRander = 0;
    let endRander = 0;
    for (let i = 0, findBottom = false; i < IFs.length; i += colCount) {
      const { node } = IFs[i];
      // 查询最靠近当前视图上边的缩略图索引
      // 缩略图在父元素的位置 - 当前视图上边位置 = 缩略图与当前视图上边的距离，如果距离 >= 0，说明缩略图在当前视图内
      if (!findBottom) {
        const distance = node.offsetTop - viewTop;
        if (distance >= 0) {
          startRander = Math.max(i - colCount, 0);
          findBottom = true;
        }
      }
      // 查询最靠近当前试图下边的缩略图索引
      if (findBottom) {
        // 当前视图下边的位置 - (缩略图在父元素的位置 + 缩略图的高度)  =  缩略图与当前视图下边的距离，如果距离 <= 0 说明缩略图在当前视图内，但仍有部分图片内容在视图外，当然此缩略图之后的图片也符合这样的条件，但此为顺序遍历
        const distance = viewButtom - (node.offsetTop + node.offsetHeight);
        endRander = Math.min(i + colCount, IFQ.length);
        if (distance <= 0) break;
      }
    }
    evLog(`要渲染的范围是:${startRander + 1}-${endRander + 1}`);
    IFs.slice(startRander, endRander + 1).forEach((f) => f.render());
  }
}

//防反跳，延迟执行，如果有新的事件则重置延迟时间，到达延迟时间后，只执行最后一次的事件
class Debouncer {
  constructor() {
    this.tids = {};
  }
  addEvent(id, event, timeout) {
    window.clearTimeout(this.tids[id]);
    this.tids[id] = window.setTimeout(event, timeout);
  }
}

//==================面向对象，图片获取器IMGFetcher，图片获取器调用队列IMGFetcherQueue=====================START

//========================================配置管理器=================================================START
const signal = { first: true };

let conf = JSON.parse(window.localStorage.getItem("cfg_"));
//获取宽度
const screenWidth = window.screen.availWidth;

if (!conf || conf.version !== "3.0.1") {
  //如果配置不存在则初始化一个
  let colCount = screenWidth > 2500 ? 8 : screenWidth > 1900 ? 7 : 5;
  conf = {
    backgroundImage: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANAAAAC4AgMAAADvbYrQAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAFi/guUAABYlAUlSJPAAAAAJUExURQwMDA8PDxISEkrSJjgAAAVcSURBVGjevZqxjtwwDETZTOOvm2Yafp0aNvzKFJRsade3ycqHLA4IcMo70LRIDsk1iDZ/0P8VbTmAZGZmpGiejaBECpLcIUH0DAUpSpIgHZkuSfTchaIJBtk4ggTJnVL94DzJkJjZNqFsECUDjwhEQpKUyXAKExSHh0T3bYgASSNn8zLpomSSSYg4Mo58BEEETaz3N35OL3SoW0iREvcgAyHzGKfoEN4g1t+qS7UBlR2ZLfO8L5J0WQh3KOABybNJfADpDfIol88vF1I6n0Ev5kFyUWodCoSOCIgfnumfoVigk1CkQpCQAVG+D/VMAuuJQ+hXij2RaCQW1lWY0s93UGaTCCFTw7bziSvyM4/MI/pJZtuHnKIy5TmCkJ4tev7qUKZSDyFXQXGFOz1beFsh11OonvjNEeGUFJN5T6GIHh1azAu9OUKSLJN70P/7jHCvotbrTEZGG0EjTSfBDG5CQfX7uUC5QBF1IlFqm1A/4kdIOi6IDyHwA5SCApKcnk+hH82bat2/P9MN1PNUr1W3lwb3d+lbqF5XRpv0wFSomTlElmz8bh9yZt5Btl7Y34MwILvM0xIaTyF3ZsYE9VMOKMav7SFUFpakQRU1dp0lm65Rr3UPIPZ7UVUSpJmB9KBkhhkyjHDfgkb+nX1bmV5OCSGkwytP0/MhFD9BdkofjSL0DJqTb6n7zObeTzKh0CkJnkIvN7OXcMnjyDghD+5BZzM3pRDIxot8EVlrevkSIj3rysyOGIKKZx+UgQzQMtsehK56V+jUJAMaqoB8Avk7pBfIT/1h+xCZGXFnni/mRRyZvWXdg8SIiLgxz18cgQ5xD/r02dJo/KjCuJhXwb80/BRcJnpOQfg95KoCIAlmBkNQQZ3TBZsLwCPILwiCiKDEOC0kxEMBUfkIGiLxgkSVhWsnjnqSZ1DwhGCz+DhdngGZXNvQmZdWMfWa4+z+9BtoxPWiMoyekUlJqM44IchDEsWH0JIvK9m0KQhNkI+JyTNo1WhvEKQa1QFPIV+KWmZTNeiAdLhMPGv1HnQ3v5pEIs1MgsvMkMQ8bPoSMpYf+wCNFdo8U1WJLBEyOI0l/HcgjysGShCOsVZ3x3BOjR9JxS50PfTxDvncXx69NW/PIa0QLS7oiKjhrYt7kGJuEeahIGVrVa3hrWITmkdY0muykRnMNEauxJx5voS0DGpXkXglyzFFOXLuNb6GYploQjqiqd8hdt2W1YbXvGYb0hvkbbR8FxS1NXgOaZlxN+/maTLvFyB/FfMepyPMjvTRoOgJ9P8+ZcQ6vAL52rfUVKYGXnwC+Yg2Xzr7VaX6M8i7eeM0XsYlb3o4apX0PdQd4Yt55QjYEptEXzBsQq/mVXWjRKDyG/oAjbUM8V3oB9let5K80Vo/a/3PkNCVR6ZCRyRAXAuSNirCWWoy2x4EnP9hzop+C+Uj6FolHcpaLqIL/FcoUmdzvAPZnXnVHwzIZkf4NkTJlF0kesylpoIwZOybQMPliG+hGmuZGfEyP3WRNdbCuVDqV+tnqGr8PXTtlY1LARgrxt4ZD+kj8SPEv0MobQvxGKp3qJ9zR/IImiWBrRrtzjz7K4QfoPHEBhquXOUTFJd5lXL2IIyXu07UMaA+5MKSez5AnCZjb9Cc6X3xLUdO5jDcGTVj+R4aY+e5u5Iou/5WrWYjIGW0zLYHnYlFOnSpjLmoRcxF7QFkA5rME+dlfUA6ukhs7tvQ7Ai/M29Z/dDFPeg/byRXOxykJM96xZimqhJ5r5Z3oP61AHo2aCSbCeLvQTFB8xd6xmL4t6BjQF1i/zp0tg31PY0OmY1taUFYHfEV9K/7x/nzB/aTFFDPHGpXAAAAAElFTkSuQmCC`,
    colCount: colCount, //每行显示的数量
    followMouse: false, //大图是否跟随鼠标
    keepScale: false, //是否保留缩放
    autoLoad: true, //是否启用空闲加载器
    fetchOriginal: false, //是否获取最佳质量的图片
    restartIdleLoader: 8000, //中止空闲加载器后的重新启动时间
    threads: 3, //同时加载的图片数量
    downloadThreads: 4, //同时下载的图片数量
    timeout: 8, //超时时间(秒)，默认8秒
    version: "3.0.1", //配置版本
    debug: true, // 是否打印控制台日志
    first: true, // 是否初次使用脚本
  };
  window.localStorage.setItem("cfg_", JSON.stringify(conf));
}

// const updateEvent = function (k, v) {
//   switch (k) {
//     case "backgroundImage": {
//       let css_ = [].slice.call(styleSheel.sheet.cssRules).filter((rule) => rule.selectorText === ".fullViewPlane")[0];
//       css_.style.backgroundImage = `url(${v})`;
//       break;
//     }
// };
//========================================配置管理器=================================================FIN

//=========================================方法区===================================================START
//图片获取器调用队列
const IFQ = new IMGFetcherQueue();
//空闲自加载器
const idleLoader = new IdleLoader(IFQ);
//页加载器
const PF = new PageFetcher(IFQ, idleLoader);
//=========================================方法区===================================================FIN

//=========================================事件库===================================================START
// 修改配置事件
function modConfEvent(ele, key, data) {
  if (["timeout", "threads", "downloadThreads", "colCount"].indexOf(key) !== -1) {
    const range = {
      colCount: [1, 12],
      threads: [1, 10],
      downloadThreads: [1, 10],
      timeout: [2, 20],
    };
    if (data === "add") {
      if (conf[key] < range[key][1]) {
        conf[key]++;
      }
    } else if (data === "minus") {
      if (conf[key] > range[key][0]) {
        conf[key]--;
      }
    }
    document.querySelector(`#${key}Input`).value = conf[key];
    if (key === "colCount") {
      const css_ = [].slice.call(styleSheel.sheet.cssRules).filter((rule) => rule.selectorText === ".fullViewPlane")?.[0];
      css_.style.gridTemplateColumns = `repeat(${conf[key]}, 1fr)`;
    }
  }
  if (["followMouse", "keepScale", "autoLoad", "fetchOriginal"].indexOf(key) !== -1) {
    conf[key] = ele.checked;
    if (key === "autoLoad") { }
    if (key === "followMouse") {
      if (conf[key]) {
        bigImageFrame.addEventListener("mousemove", followMouseEvent);
      } else {
        bigImageFrame.removeEventListener("mousemove", followMouseEvent);
        bigImageElement.style.left = "";
      }
    }
  }
  // todo backgroud image
  window.localStorage.setItem("cfg_", JSON.stringify(conf));
}

// 入口
function togglePageHelper(type) {
  const ele = document.querySelector("#pageHelper #main");
  if (ele) {
    if (type == 1) {
      ele.classList.add("b-collapse");
      hiddenFullViewPlane();
    } else {
      ele.classList.remove("b-collapse");
      showFullViewPlane();
      if (signal["first"]) {
        signal["first"] = false;
        PF.init().then(() => idleLoader.start(idleLoader.lockVer));
      }
    }
  }
}

function mouseoverPlaneEvent(target) {
  target.setAttribute("foucs", "foucs");
}

function mouseleavePlaneEvent(target) {
  target.removeAttribute("foucs");
  target.classList.add("p-collapse");
}

function togglePlaneEvent(id, type) {
  setTimeout(() => {
    let ele = document.querySelector(`#${id}Plane`);
    if (ele) {
      if (type == 0) {
        ele.classList.remove("p-collapse");
      } else if (type == 1) {
        if (ele.getAttribute("foucs") !== "foucs") {
          mouseleavePlaneEvent(ele);
          ele.classList.add("p-collapse");
        }
      } else {
        ele.classList.toggle("p-collapse");
        ["config", "downloader"].filter(k => k !== id).forEach(k => togglePlaneEvent(k, 1));
      }
    }
  }, 10);
}

const showFullViewPlane = function () {
  fullViewPlane.scroll(0, 0); //否则加载会触发滚动事件
  fullViewPlane.classList.remove("collspse_full_view");
  document.body.style.display = "none";
};

const hiddenFullViewPlaneEvent = function (event) {
  if (event.target === fullViewPlane) {
    hiddenFullViewPlane();
  }
};

const hiddenFullViewPlane = function () {
  fullViewPlane.classList.add("collspse_full_view");
  document.body.style.display = "";
  bigImageFrame.classList.add("collspse");
};

//全屏阅览元素的滚动事件
const scrollEvent = function () {
  //对冒泡的处理
  if (fullViewPlane.classList.contains("collspse_full_view")) return;
  //根据currTop获取当前滚动高度对应的未渲染缩略图的图片元素
  PF.renderCurrView(fullViewPlane.scrollTop, fullViewPlane.clientHeight);
};

//大图框架点击事件，点击后隐藏大图框架
const hiddenBigImageEvent = function (event) {
  if (event.target.tagName === "SPAN") return;
  bigImageFrame.classList.add("collspse");
  window.setTimeout(() => {
    bigImageElement.hidden = true;
  }, 700);
};

//大图框架元素的滚轮事件/按下鼠标右键滚动则是缩放/直接滚动则是切换到下一张或上一张
const bigImageWheelEvent = function (event) {
  if (event.buttons === 2) {
    scaleImageEvent(event);
  } else {
    stepImageEvent(event.deltaY > 0 ? "next" : "prev");
  }
};

//按键事件
const KeyEvent = function (event) {
  switch (event.key) {
    case "ArrowLeft":
      stepImageEvent("prev");
      break;
    case "ArrowRight":
      stepImageEvent("next");
      break;
    case "Escape":
      hiddenBigImageEvent(event);
      break;
  }
};

//大图框架添加鼠标移动事件，该事件会将让大图跟随鼠标左右移动
const followMouseEvent = function (event) {
  if (bigImageFrame.moveEventLock) return;
  bigImageFrame.moveEventLock = true;
  window.setTimeout(() => {
    bigImageFrame.moveEventLock = false;
  }, 20);
  bigImageElement.style.left = `${event.clientX - window.screen.availWidth / 2}px`;
};

//点击缩略图后展示大图元素的事件
const showBigImageEvent = function (event) {
  showBigImage(IFQ.findIndex(event.target));
};
const showBigImage = function (start) {
  //展开大图阅览元素
  bigImageFrame.classList.remove("collspse");
  bigImageElement.hidden = false;
  //获取该元素所在的索引，并执行该索引位置的图片获取器，来获取大图
  IFQ.do(start);
};

//修正图片top位置
const fixImageTop = function (mouseY, isScale) {
  //垂直轴中心锚点，用来计算鼠标距离垂直中心点的距离，值是一个正负数
  const vertAnchor = bigImageFrame.offsetHeight >> 1;
  //大图和父元素的高度差，用来修正图片的top值，让图片即使放大后也垂直居中在父元素上
  const diffHeight = bigImageElement.offsetHeight - bigImageFrame.offsetHeight - 3;
  //如果高度差<=0，说明图片没放大，不做处理
  if (diffHeight <= 0 && !isScale) return;
  // 鼠标距离垂直中心的距离，正负值
  const dist = mouseY - vertAnchor;
  /* 移动比率，根据这个来决定imgE的top位置
     1.6是一个比率放大因子，
        比如鼠标向上移动时，移动到一定的距离就能看到图片的底部了，
                          而不是鼠标移动到浏览器的顶部才能看到图片底部 */
  const rate = Math.round((dist / vertAnchor) * 1.6 * 100) / 100;
  //如果移动比率到达1或者-1，说明图片到低或到顶，停止继续移动
  if ((rate > 1 || rate < -1) && !isScale) return;
  //根据移动比率和高度差的1/2来计算需要移动的距离
  const topMove = Math.round((diffHeight >> 1) * rate);
  /* -(diffHeight >> 1) 修正图片位置基准，让放大的图片也垂直居中在父元素上 */
  bigImageElement.style.top = -(diffHeight >> 1) + topMove + "px";
};
//缩放图片事件
const scaleImageEvent = function (event) {
  //获取图片的高度, 值是百分比
  let height = bigImageElement.style.height || "100%";
  if (event.deltaY < 0) {
    //放大
    height = parseInt(height) + 15 + "%";
  } else {
    //缩小
    height = parseInt(height) - 15 + "%";
  }
  if (parseInt(height) < 100 || parseInt(height) > 200) return;
  bigImageElement.style.height = height;
  bigImageElement.style.width = height;
  //最后对图片top进行修正
  fixImageTop(event.clientY, true);
};

//加载上一张或下一张事件
const stepImageEvent = function (oriented) {
  const start = oriented === "next" ? IFQ.currIndex + 1 : oriented === "prev" ? IFQ.currIndex - 1 : 0;
  IFQ.do(start, oriented);
};

//显示简易指南事件
const showGuideEvent = function (event) {
  const guideFull = document.createElement("div");
  document.body.after(guideFull);
  guideFull.innerHTML = `<div style="width: 50vw;height: 300px;border:1px solid black;background-color:white;font-weight:bold;line-height:30px;">
  <h1>操作说明</h1>
  <ol>
  <li>点击展开，进入阅读模式</li>
  <li>稍等片刻后，缩略图会全屏陈列在页面上，在顶部可调整每行显示的图片数量，每行数量越低，缩略图越大</li>
  <li><strong style="color: orange">图片质量:</strong>默认配置下，会自动加载高质量的图片，点击缩略图也会立即加载高质量的图片</li>
  <li><strong style="color: orange">大图展示:</strong>点击缩略图，可以展开大图，在大图上滚动切换上一张下一张图片</li>
  <li><strong style="color: orange">图片缩放:</strong>在大图上鼠标右键+滚轮<strong style="color: red;">缩放</strong>图片</li>
  </ol>
  </div>`;
  guideFull.style = `position: absolute;width: 100%;height: 100%;background-color: #363c3c78;z-index: 2004;top: 0; display: flex; justify-content: center;align-items: center;`;
  guideFull.addEventListener("click", () => guideFull.remove());
};
//=========================================事件库===================================================FIN

//===============================创建入口按钮，追加到tag面板的右侧======================================START
//判断是否是Large模式，这样缩略图也算能看
if (document.querySelector("div.ths:nth-child(2)") === null) {
  const showBTNRoot = document.querySelector("#gd5");
  const tempContainer = document.createElement("div");
  tempContainer.innerHTML = `<p class="g2"><img src="https://exhentai.org/img/mr.gif"> <a id="renamelink" href="${window.location.href}?inline_set=ts_l">请切换至Large模式</a></p>`;
  showBTNRoot.appendChild(tempContainer.firstElementChild);
}
//===============================创建入口按钮，追加到tag面板的右侧======================================FIN

//====================================创建一个全屏阅读元素============================================START
const fullViewPlane = document.createElement("div");
fullViewPlane.classList.add("fullViewPlane");
fullViewPlane.classList.add("collspse_full_view");
document.body.after(fullViewPlane);
fullViewPlane.innerHTML = `
 <div id="bigImageFrame" class="bigImageFrame collspse">
    <img id="bigImageElement" />
 </div>
 <div id="pageHelper" class="pageHelper">
     <div style="position: relative">
         <div id="configPlane" class="plane p-config p-collapse">
             <div style="grid-column-start: 1; grid-column-end: 7; padding-left: 5px; margin-top: 5px;">
                 <label>
                     <span style="vertical-align: middle;">背景图片:</span>
                     <input style="vertical-align: middle; width: auto;" type="text" />
                 </label>
             </div>
             <div style="grid-column-start: 1; grid-column-end: 6; padding-left: 5px;">
                 <label style="display: flex; justify-content: space-between; padding-right: 10px;">
                     <span>每行数量:</span>
                     <span>
                         <button id="colCountMinusBTN" type="button">-</button>
                         <input id="colCountInput" value="${conf.colCount}" disabled type="text" style="width: 15px;" />
                         <button id="colCountAddBTN" type="button">+</button>
                     </span>
                 </label>
             </div>
             <div style="grid-column-start: 1; grid-column-end: 6; padding-left: 5px;">
                 <label style="display: flex; justify-content: space-between; padding-right: 10px;">
                     <span>最大同时加载:</span>
                     <span>
                         <button id="threadsMinusBTN" type="button">-</button>
                         <input id="threadsInput" value="${conf.threads}" disabled type="text" style="width: 15px;" />
                         <button id="threadsAddBTN" type="button">+</button>
                     </span>
                 </label>
             </div>
             <div style="grid-column-start: 1; grid-column-end: 6; padding-left: 5px;">
                 <label style="display: flex; justify-content: space-between; padding-right: 10px;">
                     <span>最大同时下载:</span>
                     <span>
                         <button id="downloadThreadsMinusBTN" type="button">-</button>
                         <input id="downloadThreadsInput" value="${conf.downloadThreads}" disabled type="text" style="width: 15px;" />
                         <button id="downloadThreadsAddBTN" type="button">+</button>
                     </span>
                 </label>
             </div>
             <div style="grid-column-start: 1; grid-column-end: 6; padding-left: 5px;">
                 <label style="display: flex; justify-content: space-between; padding-right: 10px;">
                     <span>超时时间(秒):</span>
                     <span>
                         <button id="timeoutMinusBTN" type="button">-</button>
                         <input id="timeoutInput" value="${conf.timeout}" disabled type="text" style="width: 15px;" />
                         <button id="timeoutAddBTN" type="button">+</button>
                     </span>
                 </label>
             </div>
             <div style="grid-column-start: 1; grid-column-end: 4; padding-left: 5px;">
                 <label>
                     <span>最佳质量:</span>
                     <input id="fetchOriginalCheckbox" ${conf.fetchOriginal ? "checked" : ""} type="checkbox" style="height: 18px; width: 18px;" />
                 </label>
             </div>
             <div style="grid-column-start: 4; grid-column-end: 7; padding-left: 5px;">
                 <label>
                     <span>自动加载:</span>
                     <input id="autoLoadCheckbox" ${conf.autoLoad ? "checked" : ""} type="checkbox" style="height: 18px; width: 18px;" />
                 </label>
             </div>
             <div style="grid-column-start: 1; grid-column-end: 4; padding-left: 5px;">
                 <label>
                     <span>大图追随鼠标:</span>
                     <input id="followMouseCheckbox" ${conf.followMouse ? "checked" : ""} type="checkbox" style="height: 18px; width: 18px;" />
                 </label>
             </div>
             <div style="grid-column-start: 4; grid-column-end: 7; padding-left: 5px;">
                 <label>
                     <span>保持缩放:</span>
                     <input id="keepScaleCheckbox" ${conf.keepScale ? "checked" : ""} type="checkbox" style="height: 18px; width: 18px;" />
                 </label>
             </div>
         </div>
         <div id="downloaderPlane" class="plane p-downloader p-collapse">
             <div id="download-notice" class="download-notice"></div>
             <canvas id="downloaderCanvas" width="337" height="250"></canvas>
             <div class="download-btn-group">
                <a id="download-force" style="color: gray;">强制下载已完成的</a>
                <a id="download-start">开始下载</a>
             </div>
         </div>
     </div>
     <div>
         <span id="gate" style="font-weight: 800; font-size: large; text-align: center;">&lessdot;📖</span>
     </div>
     <!-- <span>展开</span> -->
     <div id="main" class="b-main b-collapse">
         <div id="configPlaneBTN" class="clickable" style="z-index: 1111;"> 配置 </div>
         <div id="downloaderPlaneBTN" class="clickable" style="z-index: 1111;"> 下载 </div>
         <div class="page">
             <span class="clickable" id="p-currPage"
                 style="color:orange;">1</span>/<span id="p-total">0</span>/<span>FIN:</span><span id="p-finished">0</span>
         </div>
         <div id="collapseBTN" class="clickable">收起</div>
     </div>
     <div>
         <span style="font-weight: 800; font-size: large; text-align: center;">&gtdot;</span>
     </div>
 </div>
`;
const bigImageElement = fullViewPlane.querySelector("#bigImageElement");
const bigImageFrame = fullViewPlane.querySelector("#bigImageFrame");
const pageHelper = fullViewPlane.querySelector("#pageHelper");
bigImageFrame.addEventListener("click", hiddenBigImageEvent);
bigImageFrame.addEventListener("wheel", bigImageWheelEvent);
bigImageFrame.addEventListener("mousemove", (event) => fixImageTop(event.clientY, false));
bigImageFrame.addEventListener("contextmenu", (event) => event.preventDefault());


const configPlane = fullViewPlane.querySelector("#configPlane");
configPlane.addEventListener("mouseover", (event) => mouseoverPlaneEvent(event.target));
configPlane.addEventListener("mouseleave", (event) => mouseleavePlaneEvent(event.target));
const downloaderPlane = fullViewPlane.querySelector("#downloaderPlane");
downloaderPlane.addEventListener("mouseover", (event) => mouseoverPlaneEvent(event.target));
downloaderPlane.addEventListener("mouseleave", (event) => mouseleavePlaneEvent(event.target));

// 配置按钮
const configPlaneBTN = fullViewPlane.querySelector("#configPlaneBTN");
configPlaneBTN.addEventListener("click", () => togglePlaneEvent("config"));
// 下载按钮
const downloaderPlaneBTN = fullViewPlane.querySelector("#downloaderPlaneBTN");
downloaderPlaneBTN.addEventListener("click", () => {
  togglePlaneEvent("downloader");
  downloader.check();
});

for (const key of ["colCount", "threads", "downloadThreads", "timeout"]) {
  fullViewPlane.querySelector(`#${key}MinusBTN`).addEventListener("click", (event) => modConfEvent(event.target, key, 'minus'));
  fullViewPlane.querySelector(`#${key}AddBTN`).addEventListener("click", (event) => modConfEvent(event.target, key, 'add'));
}
for (const key of ["fetchOriginal", "autoLoad", "followMouse", "keepScale"]) {
  fullViewPlane.querySelector(`#${key}Checkbox`).addEventListener("input", (event) => modConfEvent(event.target, key));
}

const collapseBTN = fullViewPlane.querySelector("#collapseBTN");
collapseBTN.addEventListener("click", () => togglePageHelper(1));

const gate = fullViewPlane.querySelector("#gate");
gate.addEventListener("click", () => togglePageHelper(0));

bigImageElement.hidden = true;

const debouncer = new Debouncer();
//全屏阅读元素滚动事件
fullViewPlane.addEventListener("scroll", () => debouncer.addEvent("FULL-VIEW-SCROLL-EVENT", scrollEvent, 500));

//按键事件
document.addEventListener("keyup", KeyEvent);

const currPageElement = fullViewPlane.querySelector("#p-currPage");
currPageElement.addEventListener("click", () => showBigImage(IFQ.currIndex));
currPageElement.addEventListener("wheel", bigImageWheelEvent);
const totalPageElement = fullViewPlane.querySelector("#p-total");
const finishedElement = fullViewPlane.querySelector("#p-finished");
//页码指示器通用修改事件
const pageHandler = function (type, data) {
  switch (type) {
    case "fetching":
      pageHelper.classList.add("pageHelperFetching");
      break;
    case "fetched":
      pageHelper.classList.remove("pageHelperFetching");
      break;
    case "updateTotal":
      totalPageElement.textContent = data;
      downloaderCanvas.drawDebouce();
      break;
    case "updateCurrPage":
      currPageElement.textContent = data;
      downloaderCanvas.drawDebouce();
      break;
    case "updateFinished":
      finishedElement.textContent = data;
      downloaderCanvas.drawDebouce();
      break;
  }
};
//====================================创建一个全屏阅读元素============================================FIN

//=======================================创建样式表=================================================START
let styleSheel = document.createElement("style");
styleSheel.textContent = `
    .fullViewPlane {
        width: 100vw;
        height: 100vh;
        background-color: rgb(0, 0, 0);
        position: fixed;
        top: 0px;
        right: 0px;
        z-index: 1000;
        overflow: hidden scroll;
        transition: height 0.4s ease 0s;
        display: grid;
        align-content: start;
        grid-gap: 10px;
        grid-template-columns: repeat(${conf.colCount}, 1fr);
    }
    .fullViewPlane .img-node {
        position: relative;
    }
    .fullViewPlane .img-node img {
        width: 100%;
        border: 2px solid white;
        box-sizing: border-box;
    }
    .collspse_full_view {
        height: 0;
        transition: height 0.4s;
    }
    .bigImageFrame {
        position: fixed;
        width: 100%;
        height: 100%;
        right: 0;
        display: flex;
        z-index: 1001;
        background-color: #000000d6;
        justify-content: center;
        transition: width 0.4s;
    }
    .bigImageFrame>img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        position: relative;
    }
    .fullViewPlane>.pageHelper {
        position: fixed;
        display: flex !important;
        justify-content: space-between;
        right: 50px;
        line-height: 25px;
        bottom: 30px;
        background-color: rgba(114, 114, 114, 0.8);
        z-index: 1011 !important;
        box-sizing: border-box;
        font-weight: bold;
        color: rgb(135, 255, 184);
        font-size: 1rem;
        cursor: pointer;
    }
    .pageHelper:hover {
        background-color: rgba(40, 40, 40, 0.8);
    }
    .pageHelper .clickable {
        text-decoration-line: underline;
    }
    .pageHelper .clickable:hover {
        color: white;
    }
    .pageHelper .plane {
        z-index: 1010 !important;
        background-color: rgba(38, 20, 25, 0.8);
        box-sizing: border-box;
        /* border: 1px solid red; */
        position: absolute;
        left: 0;
        bottom: 25px;
        color: rgb(200, 222, 200);
        box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.2);
        transition: height 0.4s;
        overflow: hidden;
        width: 337px;
    }
    .p-collapse {
        height: 0px !important;
        transition: height 0.4s;
    }
    .pageHelper .b-main {
        width: 284px;
        overflow: hidden !important;
        transition: width 0.4s;
        display: flex;
        justify-content: space-between;
        white-space: nowrap !important;
    }
    .b-collapse {
        width: 0px !important;
        transition: width 0.4s;
    }
    .pageHelper .p-config {
        height: 300px;
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        align-content: start;
        grid-gap: 10px 0px;
    }
    .pageHelper .p-downloader {
        height: 310px;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
    }
    .p-downloader canvas {
        /* border: 1px solid greenyellow; */
    }
    .p-downloader .download-notice {
        font-size: small;
        text-align: center;
        width: 100%;
    }
    .p-downloader .downloader-btn-group {
        align-items: center;
        text-align: right;
        width: 100%;
    }
    .pageHelper .btn {
        color: rgb(255, 232, 176);
        cursor: pointer;
        border: 1px solid rgb(0, 0, 0);
        border-radius: 4px;
        height: 30px;
        font-weight: 900;
        background: rgb(70, 69, 98) none repeat scroll 0% 0%;
    }
    .fetched {
        border: 2px solid #602a5c !important;
    }
    .fetch-failed {
        border: 2px solid red !important;
    }
    .fetching {
        padding: 2px;
        border: none !important;
        animation: 1s linear infinite cco;
        -webkit-animation: 1s linear infinite cco;
    }
    .pageHelperFetching {
        border: none !important;
        animation: 1s linear infinite cco;
        -webkit-animation: 1s linear infinite cco;
    }
    @keyframes cco {
        0% {
            background-color: #f00;
        }

        50% {
            background-color: #48ff00;
        }

        100% {
            background-color: #ae00ff;
        }
    }
    .collspse {
        width: 0;
        transition: width 0.7s;
    }
    .downloadBar {
        background-color: rgba(100, 100, 100, .8);
        height: 10px;
        width: 100%;
        position: absolute;
        bottom: 0;
    }
`;
document.head.appendChild(styleSheel);
//=======================================创建样式表=================================================FIN

function evLog(msg, ...info) {
  if (conf.debug) {
    console.log(new Date().toLocaleString(), "EHVP:" + msg, ...info);
  }
}

// GM.xhr简单包装
function xhrWapper(url, refer, resType, { onprogress, onload, onerror, ontimeout }) {
  GM.xmlHttpRequest({
    method: "GET",
    url: url,
    responseType: resType,
    timeout: conf["timeout"] * 1000,
    headers: {
      Referer: refer,
      "X-Alt-Referer": refer,
    },
    onprogress,
    onload,
    onerror,
    ontimeout,
  });
}

//=======================================画廊信息==================================================START
class GalleryMeta {
  constructor($doc) {
    this.url = $doc.location.href;
    const titleList = $doc.querySelectorAll("#gd2 h1");
    if (titleList && titleList.length > 0) {
      this.title = titleList[0].textContent;
      if (titleList.length > 1) {
        this.originTitle = titleList[1].textContent;
      }
    }
    const tagTrList = $doc.querySelectorAll("#taglist tr");
    this.tag = [...tagTrList].reduce((prev, tr) => {
      const tds = tr.childNodes;
      prev[tds[0].textContent] = [...tds[1].childNodes].map((ele) => ele.textContent);
      return prev;
    }, {});
    console.log(this);
  }
}
//=======================================画廊信息==================================================FIN

//=======================================下载功能==================================================START
class Downloader {
  constructor() {
    this.meta = new GalleryMeta(document);
    this.zip = new JSZip();
    this.title = this.meta.originTitle || this.meta.title;
    this.zipFolder = this.zip.folder(this.title);
    this.zipFolder.file("meta.json", JSON.stringify(this.meta));
    this.downloading = false;
    this.downloadForceElement = document.querySelector("#download-force");
    this.downloadStartElement = document.querySelector("#download-start");
    this.downloadNoticeElement = document.querySelector("#download-notice");
    this.downloadForceElement?.addEventListener("click", () => this.download());
    this.downloadStartElement?.addEventListener("click", () => this.start());
  }
  addToDownloadZip(imgFetcher) {
    let title = imgFetcher.title;
    if (title) {
      title = title.replace(/Page\s\d+_/, "");
    } else {
      title = imgFetcher.node.childNodes?.[0]?.getAttribute("asrc")?.split("/").pop();
    }
    if (!title) {
      evLog("无法解析图片文件名，因此该图片无法下载");
      return;
    }
    this.zipFolder.file(title, imgFetcher.blobData, { binary: true });
  }
  async generate() {
    return this.zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
  }
  // check > start > download
  check() {
    if (IFQ.isFinised() && conf.fetchOriginal) return true;
    // append adviser element
    if (this.downloadNoticeElement && !this.downloading) {
      this.downloadNoticeElement.innerHTML = "<span>未启用最佳质量图片，点击此处<a>临时开启最佳质量</a></span>";
      this.downloadNoticeElement.querySelector("a")?.addEventListener("click", () => this.fetchOriginalTemporarily());
    }
    return false;
  }
  fetchOriginalTemporarily() {
    IFQ.forEach(imgFetcher => {
      if (!imgFetcher.fetchOriginal || imgFetcher.stage !== 3) {
        imgFetcher.fetchOriginal = true;
        imgFetcher.stage = 1;
      }
    });
    this.start();
  }
  start() {
    if (this.downloadNoticeElement) this.downloadNoticeElement.innerHTML = "<span>正在下载中...</span>";
    this.downloading = true;
    idleLoader.lockVer++;
    // find all of unloading imgFetcher and splice frist few imgFetchers
    idleLoader.processingIndexList = [...IFQ].map((imgFetcher, index) => (!imgFetcher.lock && imgFetcher.stage === 1 ? index : -1))
      .filter((index) => index >= 0)
      .splice(0, conf["downloadThreads"]);
    idleLoader.start(idleLoader.lockVer);
  }
  download() {
    this.downloading = false;
    this.generate().then((data) => {
      const blob = new Blob([data], { type: "application/zip" });
      saveAs(blob, this.title);
      if (this.downloadNoticeElement) this.downloadNoticeElement.innerHTML = "";
    });
  };
}
const downloader = new Downloader();

class DownloaderCanvas {
  constructor(id, queue) {
    this.canvas = document.getElementById(id);
    this.canvas.addEventListener("wheel", (event) => this.onwheel(event.deltaY));
    this.mousemoveState = { x: 0, y: 0 };
    this.canvas.addEventListener("mousemove", (event) => {
      // console.log("canvas mousemove, X:", event.offsetX, ", Y:", event.offsetY);
      this.mousemoveState = { x: event.offsetX, y: event.offsetY };
      this.drawDebouce();
    });
    this.canvas.addEventListener("click", (event) => {
      this.mousemoveState = { x: event.offsetX, y: event.offsetY };
      const index = this.computeDrawList()?.find(state => state.isSelected).index;
      showBigImage(index);
    });
    this.ctx = this.canvas.getContext("2d");
    this.queue = queue;
    this.rectSize = 12; // 矩形大小(正方形)
    this.rectGap = 6; // 矩形之间间隔
    this.columns = 15; // 每行矩形数量
    this.padding = 7; // 画布内边距
    this.scrollTop = 0; // 滚动位置
    this.scrollSize = 10; // 每次滚动粒度
  }

  onwheel(deltaY) {
    const [w, h] = this.getWH();
    const clientHeight = this.computeClientHeight();
    if (clientHeight > h) {
      deltaY = deltaY >> 1;
      this.scrollTop += deltaY;
      if (this.scrollTop < 0) this.scrollTop = 0;
      if (this.scrollTop + h > clientHeight + 20) this.scrollTop = clientHeight - h + 20;
      this.draw();
    }
  }

  drawDebouce() {
    debouncer.addEvent("DOWNLOADER-DRAW", () => this.draw(), 20);
  }

  computeDrawList() {
    const list = [];
    const [w, h] = this.getWH();
    const startX = this.computeStartX();
    const startY = -this.scrollTop;
    for (let i = 0, row = -1; i < this.queue.length; i++) {
      const currCol = i % this.columns;
      if (currCol == 0) {
        row++;
      }
      const atX = startX + ((this.rectSize + this.rectGap) * currCol);
      const atY = startY + ((this.rectSize + this.rectGap) * row);
      if (atY + this.rectSize < 0) {
        continue;
      }
      if (atY > h) {
        break;
      }
      list.push({ index: i, atX, atY, isSelected: this.isSelected(atX, atY) });
    }
    return list;
  }

  draw() {
    const [w, h] = this.getWH();
    this.ctx.clearRect(0, 0, w, h);
    const list = this.computeDrawList();
    for (const rectState of list) {
      this.drawSmallRect(
        rectState.atX,
        rectState.atY,
        this.queue[rectState.index],
        rectState.index === this.queue.currIndex,
        rectState.isSelected
      );
    }
  }

  computeClientHeight() {
    return Math.ceil(this.queue.length / this.columns) * (this.rectSize + this.rectGap) - this.rectGap;
  }

  scrollTo(index) {
    const clientHeight = this.computeClientHeight();
    const [w, h] = this.getWH();
    if (clientHeight <= h) {
      return;
    }

    // compute offsetY of index in list
    const rowNo = (Math.ceil((index + 1) / this.columns));
    const offsetY = (rowNo - 1) * (this.rectSize + this.rectGap);

    if (offsetY > h) {
      this.scrollTop = offsetY + this.rectSize - h;
      const maxScrollTop = clientHeight - h + 20;
      if (this.scrollTop + 20 <= maxScrollTop) {
        this.scrollTop += 20; //todo 
      }
    }
  }

  isSelected(atX, atY) {
    return this.mousemoveState.x - atX >= 0
      && this.mousemoveState.x - atX <= this.rectSize
      && this.mousemoveState.y - atY >= 0
      && this.mousemoveState.y - atY <= this.rectSize;
  }

  computeStartX() {
    const [w, h] = this.getWH();
    const drawW = this.rectSize * this.columns + this.rectGap * this.columns - 1;
    let startX = (w - drawW) >> 1;
    return startX;
  }

  drawSmallRect(x, y, imgFetcher, isCurr, isSelected) {
    if (imgFetcher.stage == 3) {
      this.ctx.fillStyle = "rgb(110, 200, 120)";
    } else if (imgFetcher.stage === 2) {
      const percent = imgFetcher.downloadState.loaded / imgFetcher.downloadState.total;
      this.ctx.fillStyle = `rgba(110, ${Math.ceil(percent * 200)}, 120, ${Math.max(percent, 0.1)})`;
    } else {
      this.ctx.fillStyle = "rgba(200, 200, 200, 0.1)";
    }
    this.ctx.fillRect(x, y, this.rectSize, this.rectSize);
    this.ctx.shadowColor = '#d53';
    if (isSelected) {
      this.ctx.strokeStyle = "rgb(60, 20, 200)";
      this.ctx.lineWidth = 2;
    } else if (isCurr) {
      this.ctx.strokeStyle = "rgb(255, 60, 20)";
      this.ctx.lineWidth = 2;
    } else {
      this.ctx.strokeStyle = "rgb(90, 90, 90)";
      this.ctx.lineWidth = 1;
    }
    this.ctx.strokeRect(x, y, this.rectSize, this.rectSize);
  }

  getWH() {
    return [this.canvas.width, this.canvas.height];
  }

}

const downloaderCanvas = new DownloaderCanvas("downloaderCanvas", IFQ);
// downloaderCanvas.draw();
//=======================================下载功能==================================================FIN