

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontSize: 14
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
term.options.padding = 5;
fitAddon.fit();

if (navigator.usb === undefined) {
  term.write("Please switch to a browser that supports WebUSB to use this tool.\r\n");
  throw '';
}


// In-memory filesystem
const fileSystem = {};
let currentPath = '/';
let currentCommand = '';
let fileInput = null;

let usbDevice = null;
let outEndpointNo = 0;
let inEndpointNo = 0;

// Create hidden file input
function createFileInput() {
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function (e) {
          fileSystem[file.name] = {
            content: e.target.result,
            size: file.size,
            type: file.type,
            lastModified: new Date(file.lastModified)
          };
          term.write(`\r\nUploaded: ${file.name} (${file.size} bytes)\r\n`);
          showPrompt();
        };
        reader.readAsArrayBuffer(file);
      }
    });
  }
  return fileInput;
}

function showPrompt() {
  term.write(`\r\n\x1b[34m${currentPath}\x1b[0m $ `);
}

async function usbInit() {
  await usbDevice.open();
  const conf = usbDevice.configuration;
  const interNo = conf.interfaces[0].interfaceNumber;
  const altNo = conf.interfaces[0].alternate.alternateSetting;
  const alt = conf.interfaces[0].alternate;
  console.log(`claiming interface ${interNo}`)
  await usbDevice.claimInterface(interNo);
  console.log(`selecting alternate ${altNo}`);
  await usbDevice.selectAlternateInterface(interNo, altNo);
  alt.endpoints.forEach(ep => {
    if (ep.direction === "in") {
      inEndpointNo = ep.endpointNumber;
      console.log(`input endpoint is ${ep.endpointNumber}`);
    } else {
      outEndpointNo = ep.endpointNumber;
      console.log(`output endpoint is ${ep.endpointNumber}`);
    }
  })
  window.udev = usbDevice;
}

const cte = new TextEncoder();
const ctd = new TextDecoder();

// [any int]: start piping [len] data now
// false: ok
const outCommand = async () => {
  const transResponse = await usbDevice.transferIn(inEndpointNo, 256);
  console.log(transResponse);
  const response = new Uint8Array(transResponse.data.buffer);
  console.log(response);
  const rtype = ctd.decode( response.slice(0, 4) );
  const rval = response.slice(4);
  switch (rtype) {
    case "OKAY":
      const msgIfAny = ctd.decode(rval);
      if (msgIfAny.length > 0) term.write(msgIfAny+"\r\n");
      term.write("Done\r\n");
      
      return true;
    case "FAIL":
      term.write(`Error: ${ ctd.decode(rval) }\r\n`);
      return false;
    case "DATA":
      const len = parseInt(`${ctd.decode(rval)}`, 16);
      term.write(`${len} bytes will be transferred\r\n`);
      return len;
    case "INFO":
      term.write(`(bootloader) ${ctd.decode(rval)}\r\n`);
      break;
    case "TEXT":
      term.write(ctd.decode(rval));
      break;
    default:
      term.write("INVALID PACKET!\r\n");
      break;
  }
  return await outCommand();
}

async function sendCommand(base, data=null, isStream=false) {
  const packet = new Uint8Array(512);
  packet.set( cte.encode(base) );
  let start = base.length;
  if (isStream === false) {
     if (data !== null) {
       packet.set([58], start);
       start++;
     } 
  } else {
    start = 0;
  }
  if (typeof data === "string") {
    packet.set(cte.encode(data), start);
  } else if (data instanceof Uint8Array) {
    packet.set(data, start);
  }
  console.log(`sending ${packet}`);
  await usbDevice.transferOut(outEndpointNo, packet);
  const res = await outCommand();
  if (typeof res == "number") {
    return {
      "responseType": "DataRequest",
      "dataReqLen": res
    }
  }
  return {
    "responseType": "Regular",
    "success": res
  }
}

function toDownSize(len) {
  return len.toString(16).padStart(8, '0');
}

function sendProgress(n, total, bars) {
  const f = n/total;
  const n2 = Math.floor(f*bars);
  const bstr = "=".repeat(n2).padEnd(bars, " ");
  term.write(`[${bstr}] ${Math.floor(f*100)}%\r`);
}

async function fileDownloadHandler(fileName) {
  const data = new Uint8Array(fileSystem[fileName].content);
  let reqData = sendCommand("download", toDownSize(data.byteLength));
  term.write(`Sending ${reqData.dataReqLen} bytes to client.\r\n`);
  let totalChunks = Math.floor(data.byteLength / 512);
  let sparse = data.byteLength % 512;
  let idx = 0;
  for (let i = 0; i < totalChunks; i++) {
    sendProgress(i, totalChunks, 16);
    const chunk = data.slice(idx,idx+512);
    reqData = await sendCommand("", chunk, true);
    idx += 512;
  }
  if (sparse > 0) {
    const schunk = data.slice(idx, idx+sparse);
    reqData = await sendCommand("", schunk, true);
  }
  term.write("\n");
}

async function fastbootHandler(args) {
  let response;
  switch (args[0]) {
    case "boot":
      response = await sendCommand("boot");
      break;
    case "flash":
      const partition = args[1];
      const fn = args[2];
      fileDownloadHandler(fn);
      response = await sendCommand("flash", partition);
      break;
    case "getvar":
      response = await sendCommand("getvar", args[1]);
      break;
    default:
      break;
  }
}

// Command handlers
const commands = {
  ls: () => {
    if (Object.keys(fileSystem).length === 0) {
      term.write('\r\nNo files found');
    } else {
      term.write('\r\n');
      for (const [filename, fileData] of Object.entries(fileSystem)) {
        const size = fileData.size;
        const date = new Date(fileData.lastModified).toLocaleString();
        term.write(`${filename.padEnd(20)} ${size} bytes    ${date}\r\n`);
      }
    }
    showPrompt();
  },

  upload: () => {
    term.write('\r\nSelect a file to upload...');
    const input = createFileInput();
    input.click();
  },

  clear: () => {
    term.clear();
    showPrompt();
  },

  fastboot: async (args) => {
    await fastbootHandler(args);
    showPrompt();
  },

  connect: async (args) => {
    usbDevice = await navigator.usb.requestDevice({ filters: [] });
    await usbInit();
    term.write("Connected device.");
    showPrompt();
  },

  devinfo: (args) => {
    if (!usbDevice) {
      term.write("No device connected.\r\n");
      showPrompt();
      return;
    }
    term.write(`Product Name: ${usbDevice.productName}\r\n`);
    term.write(`Manufacturer: ${usbDevice.manufacturerName}\r\n`);
    term.write(`Serial No.: ${usbDevice.serialNumber}\r\n`);
    showPrompt();
  },

  argvtest: (a) => {
    a.forEach(arg => term.write(arg + "\r\n"));
    showPrompt();
  },

  help: () => {
    term.write('\r\nAvailable commands:\r\n');
    term.write('  ls      - List files\r\n');
    term.write('  upload  - Upload a file\r\n');
    term.write('  fastboot- Execute fastboot commands\r\n');
    term.write('  clear   - Clear terminal\r\n');
    term.write('  help    - Show this help\r\n');
    term.write('  connect - Connect a USB device\r\n');
    term.write('  devinfo - Get info about connected device\r\n');
    showPrompt();
  }
};

// Handle input
term.onData(e => {
  switch (e) {
    case '\r': // Enter
      term.write('\r\n');
      const trimmedCommand = currentCommand.trim();
      if (trimmedCommand) {
        const argv = trimmedCommand.split(" ");
        const cmd = argv.shift();
        if (commands[cmd]) {
          commands[cmd](argv);
        } else {
          term.write(`\r\nCommand not found: ${cmd}`);
          showPrompt();
        }
      } else {
        showPrompt();
      }
      currentCommand = '';
      break;

    case '\u007F': // Backspace
      if (currentCommand.length > 0) {
        currentCommand = currentCommand.slice(0, -1);
        term.write('\b \b');
      }
      break;

    default:
      if (e >= String.fromCharCode(0x20) && e <= String.fromCharCode(0x7E)) {
        currentCommand += e;
        term.write(e);
      }
  }
});

// Initial prompt
term.write('\x1b[36;1mWebFastboot\x1b[0m\r\n');
term.write('\x1b[33mUse "fastboot" as you normally would, "upload" to upload files for flashing, and "connect" to connect USB devices.\r\nBasic utilities such as "ls" and "clear" are also provided.\x1b[0m');
showPrompt();
