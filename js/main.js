import * as compiler from './compiler.js';
import * as emulator from './emulator.js';
import * as storage from './storage.js';
import * as editors from './editors.js';
import * as textEditor from './text-editor.js';
import * as gfxEditor from './gfx-editor.js';
import { md5 } from './md5.js';

globalThis.emulator = emulator;

if (import.meta.env.DEV) {
  globalThis._rgbdsDebug = {
    compiler,
    emulator,
    storage,
    editors,
    textEditor,
    gfxEditor,
  };
}

var cpu_line_marker = undefined;
var start_address;
var rom;
var download_filename = null;
var addr_to_line = {};
var line_to_addr = {};
var cpu_step_interval_id;
var emu_view = '';

export function isDarkMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function escapeHTML(str) {
  var escapedHTML = document.createElement('div');
  escapedHTML.innerText = str;
  return escapedHTML.innerHTML;
}

const line_nr_regex = /([\w\-\.\/]+\.(?:asm|inc))\((\d+)\)/gi;

compiler.setLogCallback(function (str, kind) {
  var output = document.getElementById('output');
  if (str == null && kind == null) {
    output.innerHTML = '';
    return;
  }

  var html = escapeHTML(str);
  html = html.replace(line_nr_regex, function (match, file, line) {
    return '<a class="error-link" data-file="' + file + '" data-line="' + line + '">' + match + '</a>';
  });

  output.innerHTML += '<span class="' + kind + '">' + html + '</span>\n';
  output.scrollTop = output.scrollHeight;
});

const serial_log_buffer = [];
const serial_log_buffer_size = 256;
emulator.setSerialCallback(function (value) {
  var formatted_value = toHex2(value);
  document.getElementById('serial_log').innerText = '$' + formatted_value;
  serial_log_buffer.unshift(formatted_value);
  if (serial_log_buffer.length > serial_log_buffer_size) {
    serial_log_buffer.length = serial_log_buffer_size;
  }
});

export function compileCode() {
  compiler.compile(function (_rom_file, _start_address, _addr_to_line) {
    textEditor.updateErrors();
    updateFileList();

    var pc_line;
    destroyEmulator();
    document.getElementById('welcome-download-btn').disabled = typeof _rom_file == 'undefined';
    if (typeof _rom_file == 'undefined') {
      return;
    }

    rom = _rom_file;
    start_address = _start_address;
    addr_to_line = _addr_to_line;
    for (var addr in addr_to_line) {
      var [filename, line] = addr_to_line[addr];
      if (typeof line_to_addr[filename] == 'undefined') line_to_addr[filename] = {};
      if (typeof line_to_addr[filename][line] == 'undefined') line_to_addr[filename][line] = [];
      line_to_addr[filename][line].push(addr);
    }
    updateTextView();
  });
}

function destroyEmulator() {
  emulator.destroy();

  addr_to_line = {};
  line_to_addr = {};
  rom = undefined;

  textEditor.setCpuLine(null, null);
}

function initEmulator(jump_to_pc) {
  if (typeof rom == 'undefined') return;

  emulator.init(document.getElementById('emulator_screen_canvas'), rom);
  emulator.setPC(start_address);
  updateCpuState(jump_to_pc);
  updateBreakpoints();
}

function stepEmulator(step_type) {
  if (!emulator.isAvailable()) {
    initEmulator(step_type == 'single' || step_type == 'frame');
    return false;
  }
  var result = emulator.step(step_type);
  updateCpuState(step_type == 'single' || step_type == 'frame');
  return result;
}

export function updateBreakpoints() {
  emulator.clearBreakpoints();
  var breakpoints = textEditor.getBreakpoints();
  for (var data of breakpoints) {
    var [filename, line_nr, valid] = data;
    data[2] = false;
    if (typeof line_to_addr[filename] == 'undefined' || typeof line_to_addr[filename][line_nr] == 'undefined') continue;
    data[2] = true;
    for (var addr of line_to_addr[filename][line_nr]) emulator.setBreakpoint(addr);
  }
}

function handleGBKey(code, down) {
  //Map the directional keys and A/S to B/A and shift/enter to select/start
  if (code == 'ArrowRight') emulator.setKeyPad('right', down);
  if (code == 'ArrowLeft') emulator.setKeyPad('left', down);
  if (code == 'ArrowUp') emulator.setKeyPad('up', down);
  if (code == 'ArrowDown') emulator.setKeyPad('down', down);
  if (code == 'KeyS') emulator.setKeyPad('a', down);
  if (code == 'KeyA') emulator.setKeyPad('b', down);
  if (code == 'ShiftRight') emulator.setKeyPad('select', down);
  if (code == 'Enter') emulator.setKeyPad('start', down);
  if (code == 'Escape') {
    document.getElementById('cpu_run_check').checked = false;
    document.getElementById('cpu_run_check').onclick();
  }
}

const hexTable = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex2 = (num) => hexTable[num & 0xff];
const toHex4 = (num) => hexTable[(num >> 8) & 0xff] + hexTable[num & 0xff];

function toHex(num, digits) {
  if (digits === 2) {
    return '$' + toHex2(num);
  } else {
    return '$' + toHex4(num);
  }
}

const cpuDom = {
  pc: document.getElementById('cpu_pc'),
  sp: document.getElementById('cpu_sp'),
  a: document.getElementById('cpu_a'),
  bc: document.getElementById('cpu_bc'),
  de: document.getElementById('cpu_de'),
  hl: document.getElementById('cpu_hl'),
  flags: document.getElementById('cpu_flags'),
};

function updateCpuState(afterSingleStep) {
  emulator.renderScreen();

  var pc = emulator.getPC();
  cpuDom.pc.innerText = toHex(pc, 4);
  cpuDom.sp.innerText = toHex(emulator.getSP(), 4);
  cpuDom.a.innerText = toHex(emulator.getA(), 2);
  cpuDom.bc.innerText = toHex(emulator.getBC(), 4);
  cpuDom.de.innerText = toHex(emulator.getDE(), 4);
  cpuDom.hl.innerText = toHex(emulator.getHL(), 4);
  cpuDom.flags.innerText = emulator.getFlags();

  var file_line_nr = addr_to_line[pc];
  if (typeof file_line_nr == 'undefined') file_line_nr = addr_to_line[pc - 1];
  if (typeof file_line_nr != 'undefined') textEditor.setCpuLine(file_line_nr[0], file_line_nr[1], afterSingleStep);
  else textEditor.setCpuLine(null, null);
  updateVRamCanvas();
  updateTextView();
}

function updateVRamCanvas() {
  var canvas = document.getElementById('emulator_vram_canvas');
  if (canvas.style.display != '') return;

  if (emu_view == 'vram') emulator.renderVRam(canvas);
  if (emu_view == 'bg0') emulator.renderBackground(canvas, 0);
  if (emu_view == 'bg1') emulator.renderBackground(canvas, 1);
}

function updateTextView() {
  var display_text = document.getElementById('emulator_display_text');
  if (display_text.style.display != '') return;
  var data = rom;
  var bank_size = 0x4000;
  var offset = 0x0000;
  var symbols = compiler.getRomSymbols();
  if (emu_view == 'wram') {
    data = emulator.getWRam();
    bank_size = 0x1000;
    offset = 0xc000;
    symbols = compiler.getRamSymbols();
  }
  if (emu_view == 'hram') {
    data = emulator.getHRam();
    bank_size = 0x1000;
    offset = 0xff80;
    symbols = compiler.getRamSymbols();
  }
  if (emu_view == 'io') {
    var text = '';
    var registers = [
      { name: 'P1', value: 0xff00 },
      { name: 'SB', value: 0xff01 },
      { name: 'SC', value: 0xff02 },
      { name: 'DIV', value: 0xff04 },
      { name: 'TIMA', value: 0xff05 },
      { name: 'TMA', value: 0xff06 },
      { name: 'TAC', value: 0xff07 },
      { name: 'IF', value: 0xff0f },
      { name: 'LCDC', value: 0xff40 },
      { name: 'STAT', value: 0xff41 },
      { name: 'SCY', value: 0xff42 },
      { name: 'SCX', value: 0xff43 },
      { name: 'LY', value: 0xff44 },
      { name: 'LYC', value: 0xff45 },
      { name: 'DMA', value: 0xff46 },
      { name: 'BGP', value: 0xff47 },
      { name: 'OBP0', value: 0xff48 },
      { name: 'OBP1', value: 0xff49 },
      { name: 'WY', value: 0xff4a },
      { name: 'WX', value: 0xff4b },
      { name: 'KEY1', value: 0xff4d },
      { name: 'VBK', value: 0xff4f },
      { name: 'RP', value: 0xff56 },
      { name: 'BCPS', value: 0xff68 },
      { name: 'BCPD', value: 0xff69 },
      { name: 'OCPS', value: 0xff6a },
      { name: 'OCPD', value: 0xff6b },
      { name: 'SVBK', value: 0xff70 },
      { name: 'IE', value: 0xffff },
    ];
    for (var reg_info of registers) {
      text +=
        "<span style='float: left; width: 50px'>" +
        reg_info.name +
        ':</span>' +
        toHex2(emulator.readMem(reg_info.value)) +
        '<br/>';
    }
    display_text.innerHTML = text;
    return;
  }
  if (emu_view == 'serial') {
    var text = '';
    for (var n = 0; n < serial_log_buffer.length; n += 16) {
      text += serial_log_buffer.slice(n, n + 16).join(' ') + '\n';
    }
    display_text.textContent = text;
    return;
  }
  if (typeof data == 'undefined') return;

  var text =
    "<div class='emulator_display_header'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 0&nbsp; 1&nbsp; 2&nbsp; 3&nbsp; 4&nbsp; 5&nbsp; 6&nbsp; 7&nbsp; 8&nbsp; 9&nbsp; a&nbsp; b&nbsp; c&nbsp; d&nbsp; e&nbsp; f</div>";
  var symbol = null;
  var span = false;
  var span_color = 0;
  for (var n = 0; n < data.length; n += 16) {
    var hex = Array.prototype.map.call(data.slice(n, n + 16), (x) => toHex2(x));
    var bank = ~~(n / bank_size);
    var addr = n & (bank_size - 1);
    if (bank > 0) addr += bank_size;
    text += toHex2(bank) + ':' + toHex4(addr + offset);
    for (var idx = 0; idx < hex.length; idx++) {
      text += ' ';
      var new_symbol = symbols[n + idx + offset];
      if (new_symbol) {
        symbol = new_symbol;
        if (span) text += '</span>';
        span = false;
        span_color = (span_color + 71) % 360;
      } else if (new_symbol === null) {
        symbol = null;
        if (span) text += '</span>';
        span = false;
      }
      if (symbol && !span) {
        text +=
          "<span title='" +
          symbol +
          "' style='background-color: hsl(" +
          span_color +
          (isDarkMode() ? ", 30%, 30%)'>" : ", 50%, 50%)'>");
        span = true;
      }
      text += hex[idx];
    }
    if (span) text += '</span>';
    span = false;
    text += '<br/>';
  }
  display_text.innerHTML = text;
}

export function updateFileList() {
  var filelist = document.getElementById('filelist');
  filelist.textContent = '';

  for (const name of Object.keys(storage.getFiles()).sort()) {
    var entry = document.createElement('li');
    entry.textContent = name;
    filelist.appendChild(entry);

    if (name == editors.getCurrentFilename()) entry.classList.add('active');
    for (var [type, filename, line_nr, message] of compiler.getErrors()) {
      if (filename != name) continue;
      entry.classList.add(type);
      if (type == 'error') {
        entry.classList.remove('warning');
        break;
      }
    }
  }
}

function deleteFile(name) {
  if (Object.keys(storage.getFiles()).length < 2) return;
  storage.update(name, null);
  if (editors.getCurrentFilename() == name) editors.setCurrentFile(Object.keys(storage.getFiles()).sort()[0]);
  updateFileList();
}

function showTabType(type) {
  const tabTypes = ['emulator_screen_canvas', 'emulator_vram_canvas', 'emulator_display_text'];
  tabTypes.forEach((tabType) => {
    document.getElementById(tabType).style.display = type == tabType ? '' : 'none';
  });
}

export async function init(event) {
  textEditor.register('textEditorDiv', compileCode);
  gfxEditor.register('gfxEditorDiv');

  await storage.ready;

  var urlParams = new URLSearchParams(window.location.search);
  const asmOptions = (urlParams.get('asm') ?? '').trim();
  if (asmOptions != '') {
    document.getElementById('compiler_settings_asm').value = asmOptions;
    compiler.setAsmOptions(asmOptions.split(' '));
  }
  const linkOptions = (urlParams.get('link') ?? '').trim();
  if (linkOptions != '') {
    document.getElementById('compiler_settings_link').value = linkOptions;
    compiler.setLinkOptions(linkOptions.split(' '));
  }
  const fixOptions = (urlParams.get('fix') ?? '').trim();
  if (fixOptions != '') {
    document.getElementById('compiler_settings_fix').value = fixOptions;
    compiler.setFixOptions(fixOptions.split(' '));
  }

  storage.autoLoad();
  editors.setCurrentFile(Object.keys(storage.getFiles()).pop());
  updateFileList();

  document.getElementById('filelist').onclick = function (e) {
    if (!e.target.childNodes[0].wholeText) return;
    editors.setCurrentFile(e.target.childNodes[0].wholeText);

    updateFileList();
    updateCpuState();
  };
  document.getElementById('hamburger-container').onclick = function () {
    document.querySelector('body .container:first-child').classList.toggle('filelist-open');
  };
  document.getElementById('newfile').onclick = function () {
    document.getElementById('newfiledialog').style.display = 'block';
  };
  document.getElementById('newfiledialog').onclick = function (e) {
    if (e.target == document.getElementById('newfiledialog'))
      document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfiledialogclose').onclick = function () {
    document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfile_empty_create').onclick = function () {
    var result = document.getElementById('newfile_name').value;
    if (!result) return;
    if (result.indexOf('.') < 0) result += '.asm';
    if (result in storage.getFiles()) return;
    if (editors.getFileType(result) === 'text') storage.update(result, '');
    else storage.update(result, new Uint8Array(16));
    editors.setCurrentFile(result);
    updateFileList();
    document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfile_upload').onchange = function (e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    // Read all selected files in parallel and store them as they complete.
    const loadPromises = files.map(function (file) {
      const readPromise = editors.getFileType(file.name) === 'text' ? file.text() : file.arrayBuffer();
      return readPromise.then(function (data) {
        storage.update(file.name, data);
      });
    });
    Promise.all(loadPromises).then(function () {
      // Keep the previous behavior of selecting the last uploaded file.
      editors.setCurrentFile(files[files.length - 1].name);
      updateFileList();
    });
    e.target.value = '';
    document.getElementById('newfiledialog').style.display = 'none';
  };

  document.getElementById('delfile').onclick = function () {
    if (confirm('Are you sure you want to delete: ' + editors.getCurrentFilename() + '?'))
      deleteFile(editors.getCurrentFilename());
  };
  document.getElementById('newproject').onclick = function () {
    if (!confirm('Are you sure to clear the current project?')) return;
    storage.reset().then(function () {
      editors.setCurrentFile(Object.keys(storage.getFiles()).pop());
      updateFileList();
      compileCode();
    });
  };

  compileCode();

  document.getElementById('output').onclick = function (e) {
    var target = e.target;
    if (target.classList.contains('error-link')) {
      var file = target.getAttribute('data-file');
      var line = parseInt(target.getAttribute('data-line'));
      //check if the file exists and line is a number before navigating
      if (file && !isNaN(line) && storage.getFiles()[file] !== undefined) {
        editors.setCurrentFile(file);
        updateFileList();
        textEditor.gotoLine(line);
      }
    }
  };

  document.getElementById('cpu_single_step').onclick = function () {
    stepEmulator('single');
  };
  document.getElementById('cpu_frame_step').onclick = function () {
    stepEmulator('frame');
  };
  document.getElementById('cpu_reset').onclick = function () {
    initEmulator(true);
  };
  document.getElementById('cpu_run_check').onclick = function () {
    if (document.getElementById('cpu_run_check').checked) {
      function runFunction() {
        if (!document.hidden) {
          if (stepEmulator('run')) document.getElementById('cpu_run_check').checked = false;
        }
        if (document.getElementById('cpu_run_check').checked) requestAnimationFrame(runFunction);
      }
      requestAnimationFrame(runFunction);
    }
  };
  var keyboardInput = document.getElementById('emulator_screen_container');
  keyboardInput.tabIndex = -1;
  keyboardInput.onkeydown = function (e) {
    handleGBKey(e.code, true);
    e.preventDefault();
  };
  keyboardInput.onkeyup = function (e) {
    handleGBKey(e.code, false);
    e.preventDefault();
  };
  document.onkeydown = function (e) {
    if (e.code == 'F8') {
      stepEmulator('single');
      e.preventDefault();
    }
    if (e.code == 'F9') {
      stepEmulator('frame');
      e.preventDefault();
    }
  };

  document.getElementById('emulator_display_screen').onclick = function () {
    showTabType('emulator_screen_canvas');
    emu_view = 'display';
  };
  document.getElementById('emulator_display_vram').onclick = function () {
    showTabType('emulator_vram_canvas');
    emu_view = 'vram';
    updateVRamCanvas();
  };
  document.getElementById('emulator_display_bg0').onclick = function () {
    showTabType('emulator_vram_canvas');
    emu_view = 'bg0';
    updateVRamCanvas();
  };
  document.getElementById('emulator_display_bg1').onclick = function () {
    showTabType('emulator_vram_canvas');
    emu_view = 'bg1';
    updateVRamCanvas();
  };
  document.getElementById('emulator_display_rom').onclick = function () {
    showTabType('emulator_display_text');
    emu_view = 'rom';
    updateTextView();
  };
  document.getElementById('emulator_display_wram').onclick = function () {
    showTabType('emulator_display_text');
    emu_view = 'wram';
    updateTextView();
  };
  document.getElementById('emulator_display_hram').onclick = function () {
    showTabType('emulator_display_text');
    emu_view = 'hram';
    updateTextView();
  };
  document.getElementById('emulator_display_io').onclick = function () {
    showTabType('emulator_display_text');
    emu_view = 'io';
    updateTextView();
  };
  document.getElementById('emulator_display_serial').onclick = function () {
    showTabType('emulator_display_text');
    emu_view = 'serial';
    updateTextView();
  };

  function downloadRom() {
    if (typeof rom == 'undefined') return;
    var element = document.createElement('a');
    var url = window.URL.createObjectURL(new Blob([rom.buffer], { type: 'application/octet-stream' }));
    element.setAttribute('href', url);
    element.setAttribute('download', download_filename || 'rom.gb');

    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    window.URL.revokeObjectURL(url);
  }

  document.getElementById('download_rom').onclick = downloadRom;
  document.getElementById('welcome-download-btn').onclick = downloadRom;

  const md5_line_regex = /^;\s*md5\s+([0-9a-fA-F]{32})/m;
  const builds_line_regex = /^;\s*builds\s+"([^"]+)"\s+with\s+(.+)$/gm;

  function findGameConfig(hash) {
    for (const [name, data] of Object.entries(storage.getFiles())) {
      if (!name.startsWith('games/') || !name.endsWith('.asm')) continue;
      if (typeof data !== 'string') continue;
      var m = md5_line_regex.exec(data);
      if (m && m[1].toLowerCase() === hash) return name;
    }
    return null;
  }

  function parseBuildsLines(gameConfig) {
    var data = storage.getFiles()[gameConfig];
    if (typeof data !== 'string') return [];
    var builds = [];
    var m;
    builds_line_regex.lastIndex = 0;
    while ((m = builds_line_regex.exec(data))) {
      builds.push({ outputPath: m[1], flags: m[2].trim().split(/\s+/) });
    }
    return builds;
  }

  var gameConfigIndex = Object.keys(storage.getFiles())
    .filter(function (name) {
      return name.startsWith('games/') && name.endsWith('.asm');
    })
    .map(function (path) {
      var data = storage.getFiles()[path];
      var m = typeof data === 'string' ? md5_line_regex.exec(data) : null;
      var builds = parseBuildsLines(path);
      var flags = builds.reduce(function (all, build) {
        return all.concat(build.flags);
      }, []);
      return {
        path: path,
        displayName: path.slice('games/'.length).replace(/\.asm$/, ''),
        hash: m ? m[1].toLowerCase() : null,
        flags: flags,
        builds: builds,
      };
    })
    .filter(function (entry) {
      return entry.hash !== null;
    })
    .sort(function (a, b) {
      return a.displayName.localeCompare(b.displayName);
    });

  function truncateName(name, maxLen) {
    return name.length > maxLen ? name.slice(0, maxLen - 1).trimEnd() + '…' : name;
  }

  function truncateMiddle(name, maxLen) {
    if (name.length <= maxLen) return name;
    var headLen = Math.ceil((maxLen - 1) / 2);
    var tailLen = Math.floor((maxLen - 1) / 2);
    return name.slice(0, headLen).trimEnd() + '…' + name.slice(name.length - tailLen).trimStart();
  }

  var filterCheckboxes = [
    document.getElementById('welcome-filter-savestates'),
    document.getElementById('welcome-filter-batteryless'),
  ];

  function activeFilterFlags() {
    return filterCheckboxes.filter((box) => box.checked).map((box) => box.value);
  }

  function populateGameSelect(activeFlags) {
    var select = document.getElementById('welcome-game-select');
    var selectedPath = select.value;
    select.innerHTML = '';
    var defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Choose a game…';
    select.appendChild(defaultOption);
    gameConfigIndex
      .filter(function (entry) {
        return activeFlags.length === 0 || activeFlags.some((flag) => entry.flags.includes(flag));
      })
      .forEach(function (entry) {
        var option = document.createElement('option');
        option.value = entry.path;
        option.textContent = truncateName(entry.displayName, 55);
        option.title = entry.displayName;
        select.appendChild(option);
      });
    select.value = Array.from(select.options).some(function (o) {
      return o.value === selectedPath;
    })
      ? selectedPath
      : '';
  }

  function applyGameSelection(path) {
    var entry = gameConfigIndex.find(function (e) {
      return e.path === path;
    });
    var title = document.getElementById('welcome-drop-zone-title');
    var expectedMd5 = document.getElementById('welcome-expected-md5');
    var patchesWrap = document.getElementById('welcome-game-patches-wrap');
    var patchesList = document.getElementById('welcome-game-patches');
    if (!entry) {
      title.textContent = 'Upload a ROM to patch';
      title.title = '';
      expectedMd5.hidden = true;
      patchesWrap.hidden = true;
      return;
    }
    title.textContent = 'Upload ' + truncateName(entry.displayName, 45);
    title.title = entry.displayName;
    expectedMd5.textContent = 'Expected MD5: ' + entry.hash;
    expectedMd5.hidden = false;

    patchesList.innerHTML = '';
    entry.builds.forEach(function (build) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'patch-name';
      name.textContent = truncateMiddle(build.outputPath.split('/').pop(), 40);
      name.title = build.outputPath;
      var flags = document.createElement('span');
      flags.className = 'patch-flags';
      flags.textContent = build.flags.join(' ');
      li.appendChild(name);
      li.appendChild(flags);
      patchesList.appendChild(li);
    });
    patchesWrap.hidden = entry.builds.length === 0;
  }

  filterCheckboxes.forEach(function (box) {
    box.onchange = function () {
      populateGameSelect(activeFilterFlags());
      applyGameSelection(document.getElementById('welcome-game-select').value);
    };
  });
  document.getElementById('welcome-game-select').onchange = function (e) {
    applyGameSelection(e.target.value);
  };
  populateGameSelect([]);

  var overlayInfoIds = ['overlay-info', 'welcome-overlay-info'];
  var overlayFilenameIds = ['overlay-filename', 'welcome-overlay-filename'];
  var overlayHashIds = ['overlay-hash', 'welcome-overlay-hash'];
  var overlayBuildRowIds = ['overlay-build-row', 'welcome-overlay-build-row'];
  var overlayBuildSelectIds = ['overlay-build-select', 'welcome-overlay-build-select'];

  function showOverlayInfo(name, hash, gameConfig) {
    var text = gameConfig
      ? 'MD5: ' + hash + ' — matched ' + gameConfig
      : 'MD5: ' + hash + ' — no matching game config found';
    overlayFilenameIds.forEach(function (id) {
      document.getElementById(id).textContent = name;
    });
    overlayHashIds.forEach(function (id) {
      document.getElementById(id).textContent = text;
    });
    overlayInfoIds.forEach(function (id) {
      document.getElementById(id).hidden = false;
    });
  }

  function hideOverlayInfo() {
    overlayInfoIds.forEach(function (id) {
      document.getElementById(id).hidden = true;
    });
  }

  var current_game_config = null;
  var current_builds = [];

  function populateBuildSelect(builds, selectedIndex) {
    overlayBuildRowIds.forEach(function (rowId, i) {
      var row = document.getElementById(rowId);
      var select = document.getElementById(overlayBuildSelectIds[i]);
      select.innerHTML = '';
      if (builds.length === 0) {
        row.hidden = true;
        return;
      }
      builds.forEach(function (build, index) {
        var name = build.outputPath.split('/').pop();
        var option = document.createElement('option');
        option.value = index;
        option.textContent = builds.length > 1 ? name + ' (' + build.flags.join(' ') + ')' : name;
        if (index === selectedIndex) option.selected = true;
        select.appendChild(option);
      });
      select.disabled = builds.length < 2;
      row.hidden = false;
    });
  }

  function applyGameConfig(gameConfig, buildIndex) {
    current_game_config = gameConfig;
    current_builds = gameConfig ? parseBuildsLines(gameConfig) : [];
    var index = buildIndex ?? 0;
    var build = current_builds[index] || null;
    compiler.setGameConfig(gameConfig, build ? build.flags : null);
    download_filename = build ? build.outputPath.split('/').pop() : null;
    populateBuildSelect(current_builds, index);
  }

  overlayBuildSelectIds.forEach(function (id) {
    document.getElementById(id).onchange = function (e) {
      applyGameConfig(current_game_config, parseInt(e.target.value, 10));
      compileCode();
    };
  });

  function handleOverlayFile(file) {
    if (!file) return;
    file.arrayBuffer().then(function (buffer) {
      var data = new Uint8Array(buffer);
      var hash = md5(data);
      var gameConfig = findGameConfig(hash);
      storage.update('overlay.gb', data);
      applyGameConfig(gameConfig, 0);
      showOverlayInfo(file.name, hash, gameConfig);
      updateFileList();
      compileCode();

      document.getElementById('welcome-game-select').value = '';
      applyGameSelection('');
    });
  }

  function showApp() {
    document.getElementById('app-container').classList.add('visible');
    document.getElementById('back-menu-item').style.display = '';
    document.getElementById('welcome').style.display = 'none';
  }

  function hideApp() {
    document.getElementById('app-container').classList.remove('visible');
    document.getElementById('back-menu-item').style.display = 'none';
    document.getElementById('welcome').style.display = 'flex';
  }

  document.getElementById('debug-btn').onclick = function () {
    showApp();
  };
  document.getElementById('back-btn').onclick = function (e) {
    e.preventDefault();
    hideApp();
  };

  var welcomeDropZone = document.getElementById('welcome-drop-zone');
  var welcomeOverlayInput = document.getElementById('welcome_overlay_upload');

  welcomeDropZone.onclick = function () {
    welcomeOverlayInput.click();
  };
  welcomeDropZone.ondragover = function (e) {
    e.preventDefault();
    welcomeDropZone.classList.add('drag-over');
  };
  welcomeDropZone.ondragleave = function () {
    welcomeDropZone.classList.remove('drag-over');
  };
  welcomeDropZone.ondrop = function (e) {
    e.preventDefault();
    welcomeDropZone.classList.remove('drag-over');
    handleOverlayFile(e.dataTransfer.files[0]);
  };
  welcomeOverlayInput.onchange = function (e) {
    handleOverlayFile(e.target.files[0]);
    e.target.value = '';
  };
  document.getElementById('welcome-overlay-remove').onclick = function () {
    storage.update('overlay.gb', null);
    applyGameConfig(null);
    hideOverlayInfo();
    updateFileList();
    compileCode();
  };

  document.getElementById('uploadoverlaymenu').onclick = function () {
    document.getElementById('uploadoverlaydialog').style.display = 'block';
  };
  document.getElementById('uploadoverlaydialog').onclick = function (e) {
    if (e.target == document.getElementById('uploadoverlaydialog'))
      document.getElementById('uploadoverlaydialog').style.display = 'none';
  };
  document.getElementById('uploadoverlaydialogclose').onclick = function () {
    document.getElementById('uploadoverlaydialog').style.display = 'none';
  };

  var overlayDropZone = document.getElementById('overlay-drop-zone');
  var overlayInput = document.getElementById('overlay_upload');

  overlayDropZone.onclick = function () {
    overlayInput.click();
  };
  overlayDropZone.ondragover = function (e) {
    e.preventDefault();
    overlayDropZone.classList.add('drag-over');
  };
  overlayDropZone.ondragleave = function () {
    overlayDropZone.classList.remove('drag-over');
  };
  overlayDropZone.ondrop = function (e) {
    e.preventDefault();
    overlayDropZone.classList.remove('drag-over');
    handleOverlayFile(e.dataTransfer.files[0]);
  };
  overlayInput.onchange = function (e) {
    handleOverlayFile(e.target.files[0]);
    e.target.value = '';
  };
  document.getElementById('overlay-remove').onclick = function () {
    storage.update('overlay.gb', null);
    applyGameConfig(null);
    hideOverlayInfo();
    updateFileList();
    compileCode();
  };

  if ('overlay.gb' in storage.getFiles()) {
    var existingOverlay = storage.getFiles()['overlay.gb'];
    var existingHash = md5(existingOverlay);
    var existingGameConfig = findGameConfig(existingHash);
    applyGameConfig(existingGameConfig);
    showOverlayInfo('overlay.gb', existingHash, existingGameConfig);
  }

  document.getElementById('importmenu').onclick = function () {
    document.getElementById('importdialog').style.display = 'block';
  };
  document.getElementById('importdialog').onclick = function (e) {
    if (e.target == document.getElementById('importdialog'))
      document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('importdialogclose').onclick = function () {
    document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('import_gist').onclick = function () {
    storage.loadGithubGist(document.getElementById('import_gist_url').value);
    document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('import_zipfile').onchange = function (e) {
    if (e.target.files.length > 0) {
      storage.loadZip(e.target.files[0]);
      e.target.value = '';
      document.getElementById('importdialog').style.display = 'none';
    }
  };
  document.getElementById('exportmenu').onclick = function () {
    //storage.save();
    document.getElementById('exportdialog').style.display = 'block';

    document.getElementById('export_hash_url').value = storage.getHashUrl();
  };
  document.getElementById('exportdialog').onclick = function (e) {
    if (e.target == document.getElementById('exportdialog'))
      document.getElementById('exportdialog').style.display = 'none';
  };
  document.getElementById('exportdialogclose').onclick = function () {
    document.getElementById('exportdialog').style.display = 'none';
  };
  document.getElementById('export_gist').onclick = function () {
    var url = document.getElementById('export_gist_url').value;
    var username = document.getElementById('export_gist_username').value;
    var token = document.getElementById('export_gist_token').value;

    url = storage.saveGithubGist(username, token, url);
    if (url == null) {
      document.getElementById('export_gist_import_url').value = 'Gist create/update failed. Incorrect token?';
    } else {
      document.getElementById('export_gist_url').value = url;

      var auto_import_url = new URL(document.location);
      auto_import_url.hash = url;
      document.getElementById('export_gist_import_url').value = auto_import_url.toString();
    }
  };
  document.getElementById('export_zip').onclick = function () {
    storage.downloadZip();
  };

  document.getElementById('infomenu').onclick = function () {
    document.getElementById('infodialog').style.display = 'block';
  };
  document.getElementById('infodialog').onclick = function (e) {
    if (e.target == document.getElementById('infodialog')) document.getElementById('infodialog').style.display = 'none';
  };
  document.getElementById('infodialogclose').onclick = function () {
    document.getElementById('infodialog').style.display = 'none';
  };

  document.getElementById('auto_url_update').checked = storage.config.autoUrl;
  document.getElementById('auto_url_update').onclick = function () {
    storage.config.autoUrl = document.getElementById('auto_url_update').checked;
    if (storage.config.autoUrl) storage.update();
    else document.location.hash = '';
  };
  document.getElementById('auto_local_storage_update').checked = storage.config.autoLocalStorage;
  document.getElementById('auto_local_storage_update').onclick = function () {
    storage.config.autoLocalStorage = document.getElementById('auto_local_storage_update').checked;
    storage.update();
  };

  document.getElementById('settingsmenu').onclick = function () {
    document.getElementById('settingsdialog').style.display = 'block';
  };
  document.getElementById('settingsdialog').onclick = function (e) {
    if (e.target == document.getElementById('settingsdialog'))
      document.getElementById('settingsdialog').style.display = 'none';
  };
  document.getElementById('settingsdialogclose').onclick = function () {
    document.getElementById('settingsdialog').style.display = 'none';
  };
  document.getElementById('compiler_settings_set').onclick = function () {
    urlParams = new URLSearchParams(window.location.search);
    var asmOptions = document.getElementById('compiler_settings_asm').value.trim();
    if (asmOptions != '') {
      urlParams.set('asm', asmOptions);
      compiler.setAsmOptions(asmOptions.split(' '));
    } else {
      compiler.setAsmOptions([]);
      urlParams.delete('asm');
    }
    var linkOptions = document.getElementById('compiler_settings_link').value.trim();
    if (linkOptions != '') {
      urlParams.set('link', linkOptions);
      compiler.setLinkOptions(linkOptions.split(' '));
    } else {
      compiler.setLinkOptions([]);
      urlParams.delete('link');
    }
    var fixOptions = document.getElementById('compiler_settings_fix').value.trim();
    if (fixOptions != '') {
      urlParams.set('fix', fixOptions);
      compiler.setFixOptions(fixOptions.split(' '));
    } else {
      urlParams.delete('fix');
      compiler.setFixOptions([]);
    }
    var url = new URL(window.location);
    url.search = urlParams.toString();
    window.history.replaceState({}, '', url);
    document.getElementById('settingsdialog').style.display = 'none';
    compileCode();
  };
  if (urlParams.has('autorun')) {
    document.getElementById('cpu_run_check').checked = true;
    document.getElementById('cpu_run_check').onclick();
  }
}
