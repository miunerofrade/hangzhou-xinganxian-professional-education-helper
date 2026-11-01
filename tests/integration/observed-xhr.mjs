export class ObservedXHR {
  constructor() {
    this.events = [];
    this.responseType = "";
    this.status = 200;
    this.responseText = "";
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  addEventListener(type, fn) {
    if (type === "loadend") this.events.push(fn);
  }
  complete(body, status = 200) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    for (const fn of this.events) fn();
  }
}
