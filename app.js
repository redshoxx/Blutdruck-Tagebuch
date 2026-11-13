
  (() => {
    'use strict';
    // Offline-first PWA. Health data never leaves the device; no analytics or network requests for records.
    const STORE = 'blutdruck-tagebuch-lokal-v2';
    const RECOVERY = STORE + '-recovery';
    const LEGACY = 'blutdruck-tagebuch-a4-v1';
    const FILE_HANDLE_DB = 'blutdruck-auto-backup-v1';
    const PWA_DB = 'blutdruck-wochen-pwa-v1';
    const DAY_PARTS = ['frueh','mittag','abends'];
    const partNames = {frueh:'Früh',mittag:'Mittag',abends:'Abends'};
    const partIndex = {frueh:0,mittag:1,abends:2};
    const $ = id => document.getElementById(id);
    const dateLong = new Intl.DateTimeFormat('de-AT',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'});
    const dateShort = new Intl.DateTimeFormat('de-AT',{day:'2-digit',month:'2-digit',year:'numeric'});
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    let state = { selectedDate:'', records:new Map() };
    let storageOK = true;
    let locked = false;
    let encryptionKey = null;
    let encryptionSalt = null;
    let protectMode = false;
    let revision = 0;
    let currentWrapper = null;
    let recoveredFrom = '';
    let pending = false;
    let saving = false;
    let preventOverwrite = false;
    let fileHandle = null;
    let fileSaving = false;
    let fileNeedsWrite = false;
    let filePermission = false;
    let diskWarn = '';

    const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const localToday = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
    const dateObj = iso => new Date(iso+'T12:00:00');
    const validDate = iso => typeof iso==='string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(dateObj(iso).getTime()) && dateObj(iso).getFullYear()===+iso.slice(0,4) && dateObj(iso).getMonth()+1===+iso.slice(5,7) && dateObj(iso).getDate()===+iso.slice(8,10);
    const dayOffset = (iso,n) => {const d=dateObj(iso); d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
    const weekStart = iso => dayOffset(iso,-((dateObj(iso).getDay()+6)%7));
    function isoWeekValue(date) {
      const thursday=dateObj(dayOffset(weekStart(date),3));
      const yr=thursday.getFullYear();
      const firstMonday=weekStart(`${yr}-01-04`);
      const days=Math.round((dateObj(weekStart(date))-dateObj(firstMonday))/86400000);
      return `${yr}-W${String(Math.floor(days/7)+1).padStart(2,'0')}`;
    }
    function weekFromValue(v) {
      if(!/^\d{4}-W\d{2}$/.test(v)) return null;
      const yr=+v.slice(0,4),wk=+v.slice(6);
      if(yr<2000||yr>2100||wk<1||wk>53) return null;
      const monday=dayOffset(weekStart(`${yr}-01-04`),(wk-1)*7);
      return isoWeekValue(monday)===v?monday:null;
    }
    const defaultMeasure=p=>({time:'',systolic:'',diastolic:'',pulse:'',note:''});
    const emptyRecord=date=>({date,collapsed:false,measurements:Object.fromEntries(DAY_PARTS.map(p=>[p,defaultMeasure(p)]))});
    function validNum(v) {return /^\d{0,3}$/.test(String(v ?? ''))?String(v ?? ''):'';}
    function normalizeMeasure(m,p) {
      return {
        time:typeof m?.time==='string' && timePattern.test(m.time)?m.time:'',
        systolic:validNum(m?.systolic),
        diastolic:validNum(m?.diastolic),
        pulse:validNum(m?.pulse),
        note:String(m?.note ?? '').slice(0,500)
      };
    }
    function isChanged(m,p) {return !!m.time || !!m.systolic || !!m.diastolic || !!m.pulse || !!m.note;}
    function hasReadings(r) {return DAY_PARTS.some(p=>!!r.measurements[p].systolic||!!r.measurements[p].diastolic||!!r.measurements[p].pulse||!!r.measurements[p].note);}

    // Compact storage: only days and fields that differ from defaults are persisted.
    // No empty weeks, UI icons or HTML are saved in browser storage.
    function toCompact() {
      const days=[];
      for(const [date,r] of state.records) {
        const measures=[];
        DAY_PARTS.forEach((p,i)=>{
          const m=r.measurements[p];
          if(isChanged(m,p)) measures.push([i,m.time,m.systolic,m.diastolic,m.pulse,m.note]);
        });
        if(measures.length) days.push([date,measures]);
      }
      days.sort((a,b)=>a[0].localeCompare(b[0]));
      return JSON.stringify({v:3,days});
    }
    function fromCompact(obj) {
      if(!obj || ![2,3].includes(obj.v) || !Array.isArray(obj.days) || obj.days.length>9000) throw new Error('Ungültige Datensicherung.');
      const map=new Map();
      for(const day of obj.days) {
        if(!Array.isArray(day)||day.length!==2||!validDate(day[0])||!Array.isArray(day[1])||day[1].length>3||map.has(day[0])) throw new Error('Ungültige oder doppelte Tagesdaten.');
        const rec=emptyRecord(day[0]), used=new Set();
        for(const line of day[1]) {
          if(!Array.isArray(line)||line.length!==(obj.v===3?6:5)||!Number.isInteger(line[0])||line[0]<0||line[0]>2||used.has(line[0])) throw new Error('Ungültiger Messeintrag.');
          used.add(line[0]);
          const p=DAY_PARTS[line[0]];
          rec.measurements[p]=normalizeMeasure({time:line[1]||'',systolic:line[2],diastolic:line[3],pulse:obj.v===3?line[4]:'',note:obj.v===3?line[5]:line[4]},p);
        }
        map.set(day[0],rec);
      }
      return map;
    }
    function fromLegacy(obj) {
      if(!obj || !Array.isArray(obj.records)||obj.records.length>9000) throw new Error('Keine gültige Sicherungsdatei.');
      const map=new Map();
      for(const r of obj.records) {
        if(!r||!validDate(r.date)||!r.measurements||map.has(r.date)) throw new Error('Ungültige oder doppelte Tagesdaten.');
        const rec=emptyRecord(r.date);
        for(const p of DAY_PARTS) rec.measurements[p]=normalizeMeasure(r.measurements[p]||{},p);
        if(DAY_PARTS.some(p=>isChanged(rec.measurements[p],p))) map.set(rec.date,rec);
      }
      return map;
    }

    // FNV-1a checksum only detects accidental damage. Encryption below provides authentication.
    function checksum(s) {let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
    function wrapped(payload,encrypted,meta={}) {
      const base={version:2,revision:++revision,updated:new Date().toISOString(),encrypted,payload,...meta};
      return JSON.stringify({...base,checksum:checksum(JSON.stringify(base))});
    }
    function readWrapper(raw) {
      if(typeof raw!=='string'||raw.length>3_000_000) throw new Error('Sicherungsdaten unvollständig.');
      const o=JSON.parse(raw);
      if(!o||o.version!==2||typeof o.payload!=='string'||typeof o.checksum!=='string'||typeof o.encrypted!=='boolean'||!Number.isSafeInteger(o.revision)) throw new Error('Unbekanntes Sicherungsformat.');
      const {checksum:stored,...base}=o;
      if(checksum(JSON.stringify(base))!==stored) throw new Error('Prüfsumme der Daten ist fehlerhaft.');
      if(o.encrypted && (!o.salt||!o.iv)) throw new Error('Verschlüsselungsdaten fehlen.');
      return o;
    }
    const bytesToB64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
    const b64ToBytes=b64=>Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
    async function deriveKey(secret,salt) {
      if(!crypto?.subtle) throw new Error('Verschlüsselung wird in diesem Browser nicht unterstützt.');
      const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),'PBKDF2',false,['deriveKey']);
      return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:240000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    }
    async function encrypt(text,key) {
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text));
      return {payload:bytesToB64(new Uint8Array(cipher)),iv:bytesToB64(iv)};
    }
    async function decrypt(wrapper,key) {
      const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(wrapper.iv)},key,b64ToBytes(wrapper.payload));
      return new TextDecoder().decode(bytes);
    }

    function message(text,error=false) {
      const s=$('saveStatus');s.textContent=text;s.classList.toggle('error',error);
    }
    function refreshStatus() {
      if(locked){message('Gesperrt · Passwort erforderlich');return;}
      if(preventOverwrite){message('Speicherfehler: alte Daten nicht überschrieben. Sicherung öffnen.',true);return;}
      if(!storageOK){message('ACHTUNG: Nicht gespeichert! Bitte Sicherung herunterladen.',true);return;}
      if(pending||saving){message('Wird lokal gespeichert …');return;}
      const ending=fileHandle?(filePermission?(fileSaving||fileNeedsWrite?' · PC-Sicherung läuft':' · PC-Sicherung verbunden'):' · PC-Sicherung erneut freigeben'):'';
      message('Lokal gespeichert'+(protectMode?' · verschlüsselt':'')+ending+(diskWarn?' · PC-Datei prüfen':''),!!diskWarn);
    }
    // IndexedDB stores only compact data wrappers, not HTML, cached pages or a list of blank weeks.
    // current/recovery are independent records in the local DB. A downloaded JSON backup
    // remains essential because deleting app data can delete BOTH local copies.
    function openPwaDb() {
      return new Promise((resolve,reject)=>{
        if(!('indexedDB' in window))return reject(new Error('IndexedDB nicht verfügbar'));
        const request=indexedDB.open(PWA_DB,1);
        request.onupgradeneeded=()=>{
          const db=request.result;
          if(!db.objectStoreNames.contains('snapshots'))db.createObjectStore('snapshots');
        };
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error||new Error('IndexedDB nicht verfügbar'));
        request.onblocked=()=>reject(new Error('Datenbank wird in einem anderen Fenster verwendet'));
      });
    }
    async function dbReadSnapshots() {
      const db=await openPwaDb();
      try { return await new Promise((resolve,reject)=>{
        const tx=db.transaction('snapshots','readonly');
        const store=tx.objectStore('snapshots');
        const a=store.get('current'), b=store.get('recovery');
        let current=null,recovery=null;
        a.onsuccess=()=>{current=a.result||null;};
        b.onsuccess=()=>{recovery=b.result||null;};
        tx.oncomplete=()=>resolve({current,recovery});
        tx.onerror=()=>reject(tx.error||new Error('Lesefehler'));
        tx.onabort=()=>reject(tx.error||new Error('Lesefehler'));
      }); } finally {db.close();}
    }
    async function dbWriteWrapper(value,securityChange) {
      const db=await openPwaDb();
      try { await new Promise((resolve,reject)=>{
        const tx=db.transaction('snapshots','readwrite');
        const store=tx.objectStore('snapshots');
        if(securityChange){
          store.put(value,'current');
          store.put(value,'recovery');
        }else{
          const previous=currentWrapper;
          if(previous)store.put(previous,'recovery');
          store.put(value,'current');
        }
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error||new Error('Schreibfehler'));
        tx.onabort=()=>reject(tx.error||new Error('Schreibfehler'));
      }); } finally {db.close();}
    }
    function storeFallback(value,securityChange) {
      if(securityChange) {
        // When enabling encryption do not keep plaintext recovery copies.
        localStorage.setItem(STORE,value);
        localStorage.setItem(RECOVERY,value);
        localStorage.removeItem(LEGACY);
      } else {
        const previous=localStorage.getItem(STORE);
        if(previous)localStorage.setItem(RECOVERY,previous);
        localStorage.setItem(STORE,value);
      }
    }
    async function commitWrapper(value,securityChange=false) {
      try {
        await dbWriteWrapper(value,securityChange);
        // Once migrated, legacy plaintext snapshots must not linger beside encrypted data.
        try{localStorage.removeItem(STORE);localStorage.removeItem(RECOVERY);localStorage.removeItem(LEGACY);}catch(_){}
        currentWrapper=value;
        storageOK=true;
        return true;
      }catch(dbErr){
        console.warn('IndexedDB-Speicherung nicht möglich',dbErr);
        if(securityChange){storageOK=false;return false;}
        try {
          storeFallback(value,securityChange);
          currentWrapper=value;
          storageOK=true;
          return true;
        }catch(err) {
          console.error('Keine lokale Speicherung möglich',err);
          storageOK=false;
          return false;
        }
      }
    }
    // Serialize all writes, including fast keyboard input and encryption.
    function persist() {
      if(locked || preventOverwrite) {refreshStatus();return;}
      pending=true;
      refreshStatus();
      if(!saving)void flushAll();
    }
    async function flushAll() {
      if(saving)return;
      saving=true;
      while(pending && !locked && !preventOverwrite) {
        pending=false;
        const snap=toCompact();
        try {
          let wrapper;
          if(protectMode){
            const cipher=await encrypt(snap,encryptionKey);
            wrapper=wrapped(cipher.payload,true,{salt:encryptionSalt,iv:cipher.iv});
          } else wrapper=wrapped(snap,false);
          if(!await commitWrapper(wrapper))throw new Error('Schreiben fehlgeschlagen');
          queueFileWrite();
        }catch(e){console.error(e);storageOK=false;pending=false;break;}
      }
      saving=false;
      refreshStatus();
    }
    async function flushPending() {
      for(let i=0;(saving||pending)&&i<150;i++)await new Promise(resolve=>setTimeout(resolve,25));
      if(saving||pending||!storageOK)throw new Error('Die letzten Änderungen konnten noch nicht gesichert werden.');
    }

    function askPassword(title,description,confirm=false) {
      return new Promise(resolve=>{
        const dlg=$('passwordDialog'),form=$('passwordForm');
        $('passwordTitle').textContent=title;
        $('passwordText').textContent=description;
        $('passwordRepeatArea').hidden=!confirm;
        $('passwordRepeat').required=confirm;
        $('passwordInput').value='';$('passwordRepeat').value='';$('passwordError').textContent='';
        let settled=false;
        function finish(result) {
          if(settled)return;settled=true;
          form.removeEventListener('submit',submit);
          $('passwordCancel').removeEventListener('click',cancel);
          dlg.removeEventListener('cancel',cancel);
          if(dlg.open)dlg.close();
          resolve(result);
        }
        function cancel(e){e.preventDefault();finish(null);}
        function submit(e){
          e.preventDefault();
          const secret=$('passwordInput').value;
          if(secret.length<8){$('passwordError').textContent='Mindestens acht Zeichen eingeben.';return;}
          if(confirm && secret!==$('passwordRepeat').value){$('passwordError').textContent='Die Passwörter stimmen nicht überein.';return;}
          finish(secret);
        }
        form.addEventListener('submit',submit);
        $('passwordCancel').addEventListener('click',cancel);
        dlg.addEventListener('cancel',cancel);
        dlg.showModal();
        $('passwordInput').focus();
      });
    }

    async function loadExisting() {
      let invalidExisting=false;
      let candidates=[];
      try {
        const local=await dbReadSnapshots();
        candidates.push(['IndexedDB aktuell',local.current],['IndexedDB Wiederherstellung',local.recovery]);
      }catch(e){console.warn('IndexedDB noch nicht zugänglich',e);}
      // Legacy data from the previous single-file app can be migrated if both versions
      // are accessed under the same origin. Different file:// origins require JSON import.
      try{
        candidates.push([STORE,localStorage.getItem(STORE)],[RECOVERY,localStorage.getItem(RECOVERY)]);
      }catch(e){console.warn('Alter Browser-Speicher nicht lesbar',e);}
      for(const [source,raw] of candidates){
        if(!raw)continue;
        try{
          const wrapper=readWrapper(raw);
          currentWrapper=raw;
          revision=Math.max(revision,wrapper.revision);
          if(source.includes('Wiederherstellung') || source===RECOVERY)recoveredFrom='Eine lokale Wiederherstellungskopie wurde geladen.';
          if(wrapper.encrypted){
            locked=true;protectMode=true;encryptionSalt=wrapper.salt;
          }else{
            state.records=fromCompact(JSON.parse(wrapper.payload));
          }
          // Even encrypted snapshots can be migrated without knowing the password.
          if(source===STORE||source===RECOVERY){
            const migrated=await commitWrapper(raw,true);
            if(migrated)recoveredFrom='Frühere lokale Einträge wurden in die App-Datenbank übernommen.';
          } else if(source.includes('Wiederherstellung')) {
            await commitWrapper(raw,true);
          }
          return wrapper;
        }catch(e){invalidExisting=true;console.warn('Lokaler Datenstand konnte nicht gelesen werden',source,e);}
      }
      try{
        const legacyRaw=localStorage.getItem(LEGACY);
        if(legacyRaw){
          const legacyObj=JSON.parse(legacyRaw);
          state.records=fromLegacy(legacyObj);
          recoveredFrom='Frühere Einträge wurden übernommen.';
        }
      }catch(e){console.warn('Alte Daten konnten nicht übernommen werden',e);}
      if(invalidExisting&&!state.records.size){preventOverwrite=true;storageOK=false;}
      return null;
    }

    // The browser usually retains a file:// page's storage by its exact local path.
    // A manually exported backup remains portable even when the HTML file is moved.
    function newBackupFile(name,contents) {
      const blob=new Blob([contents],{type:'application/json;charset=utf-8'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    }
    function backupName(){return 'Blutdruck_Sicherung_'+localToday()+(protectMode?'_verschluesselt':'')+'.json';}

    // Optional disk backup with a file chosen explicitly by the user.
    // The file is never uploaded; user permissions are respected.
    function openHandleDb() {
      return new Promise((resolve,reject)=>{
        if(!('indexedDB' in window))return reject(new Error('Keine Dateiablage verfügbar.'));
        const request=indexedDB.open(FILE_HANDLE_DB,1);
        request.onupgradeneeded=()=>request.result.createObjectStore('settings');
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
    }
    async function dbSetHandle(handle) {
      const db=await openHandleDb();
      try{await new Promise((resolve,reject)=>{
        const tx=db.transaction('settings','readwrite');tx.objectStore('settings').put(handle,'backupFile');
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
      });}finally{db.close();}
    }
    async function dbGetHandle() {
      const db=await openHandleDb();
      try {return await new Promise((resolve,reject)=>{
        const tx=db.transaction('settings','readonly');const req=tx.objectStore('settings').get('backupFile');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });} finally {db.close();}
    }
    // Never overwrite an existing file that differs from the browser state
    // without explicitly approving the replacement. A cleared browser cache
    // must not silently erase the only remaining independent disk backup.
    async function checkExistingDiskBackup(handle,askBeforeOverwrite) {
      const file=await handle.getFile();
      if(!file.size)return true;
      if(file.size>3_000_000)throw new Error('Bestehende Sicherungsdatei zu groß.');
      const content=await file.text();
      if(!content.trim()||content===currentWrapper)return true;
      readWrapper(content); // unknown/corrupt file must not be silently destroyed
      if(!askBeforeOverwrite)return false;
      return confirm('Diese PC-Datei enthält bereits eine andere Blutdruck-Sicherung. Soll sie durch die aktuellen lokalen Daten ersetzt werden? Wenn du unsicher bist, wähle Abbrechen und öffne die Sicherungsdatei zuerst.');
    }
    async function restoreLinkedFile() {
      if(!('showSaveFilePicker' in window))return;
      $('linkFileBtn').hidden=false;
      try {
        const saved=await dbGetHandle();
        if(!saved)return;
        fileHandle=saved;
        filePermission=(await saved.queryPermission({mode:'readwrite'}))==='granted';
        $('linkFileBtn').textContent=filePermission?'PC-Sicherung ändern':'PC-Sicherung freigeben';
        if(filePermission) {
          const same=await checkExistingDiskBackup(saved,false);
          if(!same){
            filePermission=false;
            diskWarn='Gespeicherte PC-Datei unterscheidet sich';
            $('linkFileBtn').textContent='PC-Sicherung prüfen';
          } else queueFileWrite();
        }
        refreshStatus();
      }catch(e){
        diskWarn='Dateisicherung prüfen';filePermission=false;
        $('linkFileBtn').textContent='PC-Sicherung prüfen';
        console.warn('Speicherdatei konnte nicht wiederhergestellt werden:',e);
        refreshStatus();
      }
    }
    async function connectFile() {
      if(locked){alert('Bitte zuerst das Tagebuch entsperren.');return;}
      try {
        if(fileHandle&&!filePermission) {
          const p=await fileHandle.requestPermission({mode:'readwrite'});
          if(p==='granted'){
            if(await checkExistingDiskBackup(fileHandle,true)) {
              filePermission=true;diskWarn='';
              $('linkFileBtn').textContent='PC-Sicherung ändern';
              queueFileWrite();refreshStatus();return;
            }
            return;
          }
        }
        const handle=await window.showSaveFilePicker({suggestedName:'Blutdruck_Autosicherung.json',types:[{description:'Lokale JSON-Sicherungsdatei',accept:{'application/json':['.json']}}]});
        if((await handle.queryPermission({mode:'readwrite'}))!=='granted'){
          const perm=await handle.requestPermission({mode:'readwrite'});
          if(perm!=='granted')throw new Error('Speicherzugriff wurde nicht freigegeben.');
        }
        if(!await checkExistingDiskBackup(handle,true))return;
        fileHandle=handle;filePermission=true;diskWarn='';
        await dbSetHandle(handle);
        $('linkFileBtn').textContent='PC-Sicherung ändern';
        queueFileWrite();refreshStatus();
      }catch(e){if(e?.name!=='AbortError')alert('PC-Sicherung nicht eingerichtet: '+e.message);}
    }
    function queueFileWrite() {
      if(!fileHandle||!filePermission||!currentWrapper||locked||preventOverwrite)return;
      fileNeedsWrite=true;
      if(!fileSaving)void drainFileWrites();
    }
    async function drainFileWrites() {
      if(fileSaving)return;
      fileSaving=true;
      while(fileNeedsWrite&&fileHandle&&filePermission) {
        fileNeedsWrite=false;
        const snapshot=currentWrapper;
        try {
          const writer=await fileHandle.createWritable();
          await writer.write(snapshot);
          await writer.close();
          diskWarn='';
        }catch(e){
          console.error('PC-Sicherungsdatei konnte nicht geschrieben werden:',e);
          diskWarn=e.message||'Fehler';filePermission=false;
          $('linkFileBtn').textContent='PC-Sicherung freigeben';
          break;
        }
      }
      fileSaving=false;refreshStatus();
    }

    function svg(name) {
      const shapes={
        calendar:'<rect x="3" y="5" width="18" height="16" rx="1"/><path d="M7 2v6M17 2v6M3 10h18M7 14h3M12 14h3"/>',
        sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2 2M17.8 17.8l2 2M4.2 19.8l2-2M17.8 6.2l2-2"/>',
        sunrise:'<path d="M2 18h20M6 14a6 6 0 0 1 12 0M12 2v5M2.5 6l4 4M21.5 6l-4 4"/>',
        moon:'<path d="M20.5 16.5A9 9 0 0 1 7.5 3.5 9 9 0 1 0 20.5 16.5Z"/>',
        trash:'<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
        chevron:'<path d="m5 15 7-7 7 7"/>'
      };
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
    }
    function rowMarkup(rec,part) {
      const m=rec.measurements[part],key=rec.date+'-'+part;
      return `<div class="measurement" data-period="${part}">
        <div class="period">${svg({frueh:'sunrise',mittag:'sun',abends:'moon'}[part])}<span>${partNames[part]}</span></div>
        <div class="time-cell"><label class="mobile-field-label" for="time-${key}">Uhrzeit</label><label class="sr-only" for="time-${key}">Uhrzeit ${partNames[part]}</label><input class="time-choice" id="time-${key}" data-field="time" data-period="${part}" type="time" step="60" value="${esc(m.time)}"></div>
        <div class="pressure-cell"><div class="pressure"><label class="bp-field" for="sys-${key}"><span class="mini-label">Systole (SYS)</span><input class="field bp-input" id="sys-${key}" type="number" min="30" max="300" step="1" inputmode="numeric" aria-label="Systole ${partNames[part]}" placeholder="SYS" data-field="systolic" data-period="${part}" value="${esc(m.systolic)}"></label><span class="slash">/</span><label class="bp-field" for="dia-${key}"><span class="mini-label">Diastole (DIA)</span><input class="field bp-input" id="dia-${key}" type="number" min="20" max="220" step="1" inputmode="numeric" aria-label="Diastole ${partNames[part]}" placeholder="DIA" data-field="diastolic" data-period="${part}" value="${esc(m.diastolic)}"></label><span class="slash">·</span><label class="bp-field" for="pulse-${key}"><span class="mini-label">Puls</span><input class="field bp-input pulse-input" id="pulse-${key}" type="number" min="20" max="250" step="1" inputmode="numeric" aria-label="Puls ${partNames[part]} (Schläge pro Minute)" placeholder="Puls" title="Puls pro Minute" data-field="pulse" data-period="${part}" value="${esc(m.pulse)}"></label></div></div>
        <div class="note-cell"><label class="mobile-field-label" for="note-${key}">Notiz</label><label class="sr-only" for="note-${key}">Notiz ${partNames[part]}</label><textarea class="field note" id="note-${key}" data-field="note" data-period="${part}" rows="1" maxlength="500" placeholder="Optionale Notiz">${esc(m.note)}</textarea></div><div class="action-spacer"></div>
      </div>`;
    }
    // Some mobile browsers (notably Safari on iPhone) do not support type=week.
    // The alternative ISO week/year selectors still allow jumping to any calendar week.
    function setWeekOptions(year, selectedWeek) {
      const count=Number(isoWeekValue(`${year}-12-28`).slice(6));
      const selector=$('weekNumber');
      selector.innerHTML=Array.from({length:count},(_,i)=>`<option value="${i+1}">KW ${i+1}</option>`).join('');
      selector.value=String(Math.min(Number(selectedWeek)||1,count));
    }
    function initWeekPicker() {
      const probe=document.createElement('input');
      probe.type='week';
      if(probe.type==='week' && !smallScreen.matches)return;
      $('selectedWeek').hidden=true;
      $('weekFallback').hidden=false;
      $('weekYear').innerHTML=Array.from({length:101},(_,i)=>`<option value="${2000+i}">${2000+i}</option>`).join('');
    }
    function chooseFallbackWeek() {
      const value=`${$('weekYear').value}-W${$('weekNumber').value.padStart(2,'0')}`;
      const monday=weekFromValue(value);
      if(!monday) {render();return;}
      state.selectedDate=monday;
      render();
    }
    function render() {
      const monday=weekStart(state.selectedDate),sunday=dayOffset(monday,6);
      const weekValue=isoWeekValue(monday);
      $('selectedWeek').value=weekValue;
      if(!$('weekFallback').hidden) {
        $('weekYear').value=weekValue.slice(0,4);
        setWeekOptions(Number(weekValue.slice(0,4)),Number(weekValue.slice(6)));
      }
      $('weekHeading').textContent=`KW ${Number(isoWeekValue(monday).slice(6))} · ${dateShort.format(dateObj(monday))} – ${dateShort.format(dateObj(sunday))}`;
      $('startupNotice').hidden=true;
      $('dayList').innerHTML=Array.from({length:7},(_,i)=>{
        const date=dayOffset(monday,i),r=state.records.get(date)||emptyRecord(date);
        return `<section class="day-card${r.collapsed?' collapsed':''}" data-date="${date}">
          <header class="day-head"><div class="day-title">${svg('calendar')}<span class="date-text">${esc(dateLong.format(dateObj(date)))}</span></div>
          <div class="day-controls"><button type="button" class="icon-btn" data-action="toggle" title="Tag ein- oder ausklappen" aria-label="Tag ein- oder ausklappen" aria-expanded="${!r.collapsed}">${svg('chevron').replace('<svg','<svg class="'+(r.collapsed?'rotate':'')+'"')}</button><button type="button" class="icon-btn danger" data-action="clear" title="Messwerte dieses Tages löschen" aria-label="Messwerte dieses Tages löschen">${svg('trash')}</button></div></header>
          ${DAY_PARTS.map(p=>rowMarkup(r,p)).join('')}
        </section>`;
      }).join('');
    }
    function updateField(t) {
      if(locked)return;
      const card=t.closest('[data-date]');if(!card||!DAY_PARTS.includes(t.dataset.period)||!['time','systolic','diastolic','pulse','note'].includes(t.dataset.field))return;
      const date=card.dataset.date;
      let rec=state.records.get(date);
      if(!rec){rec=emptyRecord(date);state.records.set(date,rec);}
      const field=t.dataset.field,part=t.dataset.period;
      let value=String(t.value).slice(0,field==='note'?500:40);
      if(field==='time' && value!=='' && !timePattern.test(value))return;
      if(field==='systolic'||field==='diastolic'||field==='pulse')value=validNum(value);
      rec.measurements[part][field]=value;
      if(!DAY_PARTS.some(p=>isChanged(rec.measurements[p],p)))state.records.delete(date);
      persist();
    }
    function buildPrintReport() {
      const monday=weekStart(state.selectedDate);
      const weeks=$('printScope').value==='selected'?[monday]:[...new Set([...state.records.values()].filter(hasReadings).map(r=>weekStart(r.date)))].sort();
      if(!weeks.length){alert('Noch keine Wochen mit Messwerten vorhanden. Bitte „Ausgewählte Woche“ wählen.');return false;}
      $('printReport').innerHTML=weeks.map(start=>{
        const days=Array.from({length:7},(_,i)=>{
          const date=dayOffset(start,i),r=state.records.get(date)||emptyRecord(date);
          return `<div class="print-card"><div class="print-day-head">${esc(dateLong.format(dateObj(date)))}</div>${DAY_PARTS.map(p=>{
            const m=r.measurements[p];
            return `<div class="print-values"><div>${partNames[p]}</div><div>${esc(m.time)}</div><div>${esc(m.systolic)}</div><div>${esc(m.diastolic)}</div><div>${esc(m.pulse)}</div><div>${esc(m.note)}</div></div>`;
          }).join('')}</div>`;
        }).join('');
        return `<section class="print-page"><div class="print-table-head"><div>Tageszeit</div><div>Uhrzeit</div><div>SYS</div><div>DIA</div><div>Puls</div><div>Notiz</div></div>${days}</section>`;
      }).join('');
      return true;
    }
    function setLockedUI(isLocked) {
      locked=isLocked;
      $('dayList').inert=isLocked;
      $('printBtn').disabled=isLocked;
      $('backupBtn').disabled=isLocked;
      $('selectedWeek').disabled=isLocked;
      $('weekNumber').disabled=isLocked;
      $('weekYear').disabled=isLocked;
      $('prevWeek').disabled=isLocked;
      $('nextWeek').disabled=isLocked;
      $('currentWeekBtn').disabled=isLocked;
      $('protectBtn').textContent=protectMode?(locked?'Entsperren':'Passwortschutz aktiv'):'Passwortschutz';
      refreshStatus();
    }
    async function unlock(wrapper) {
      for(let tries=0;tries<3;tries++) {
        const password=await askPassword('Tagebuch entsperren','Dieses Tagebuch ist lokal verschlüsselt. Gib dein Passwort ein, um die Messwerte anzuzeigen.');
        if(password===null)return false;
        try {
          const key=await deriveKey(password,b64ToBytes(wrapper.salt));
          const parsed=JSON.parse(await decrypt(wrapper,key));
          const map=fromCompact(parsed);
          encryptionKey=key;encryptionSalt=wrapper.salt;protectMode=true;
          state.records=map;
          preventOverwrite=false;
          if(recoveredFrom)await commitWrapper(currentWrapper,true);
          setLockedUI(false);
          render();
          if(fileHandle&&filePermission) {
            try {if(await checkExistingDiskBackup(fileHandle,false))queueFileWrite();}
            catch(e){diskWarn='PC-Sicherung prüfen';filePermission=false;refreshStatus();}
          }
          return true;
        }catch(e){alert('Passwort falsch oder Sicherung beschädigt.');}
      }
      return false;
    }
    async function toggleProtection() {
      if(locked) {
        const wrapper=readWrapper(currentWrapper);
        await unlock(wrapper);
        return;
      }
      if(!protectMode) {
        const password=await askPassword('Passwortschutz aktivieren','Deine Werte werden mit AES-256-GCM lokal verschlüsselt. Das Passwort wird nicht gespeichert. Ohne Passwort können die verschlüsselten Daten nicht wiederhergestellt werden.',true);
        if(password===null)return;
        try {
          await flushPending();
          const salt=crypto.getRandomValues(new Uint8Array(16));
          const key=await deriveKey(password,salt);
          const snap=await encrypt(toCompact(),key);
          const next=wrapped(snap.payload,true,{salt:bytesToB64(salt),iv:snap.iv});
          if(!await commitWrapper(next,true))throw new Error('Verschlüsselte Speicherung fehlgeschlagen.');
          encryptionKey=key;encryptionSalt=bytesToB64(salt);protectMode=true;
          $('protectBtn').textContent='Passwortschutz aktiv';
          queueFileWrite();refreshStatus();
        }catch(e){alert('Passwortschutz konnte nicht aktiviert werden: '+e.message);}
      }else {
        if(!confirm('Passwortschutz wirklich deaktivieren? Danach werden die Messwerte unverschlüsselt im lokalen Browser-Speicher abgelegt.'))return;
        const password=await askPassword('Schutz deaktivieren','Zur Sicherheit noch einmal das aktuelle Passwort eingeben.');
        if(password===null)return;
        try {
          const key=await deriveKey(password,b64ToBytes(encryptionSalt));
          await decrypt(readWrapper(currentWrapper),key);
          const next=wrapped(toCompact(),false);
          if(!await commitWrapper(next,true))throw new Error('Speicherung nicht möglich.');
          encryptionKey=null;encryptionSalt=null;protectMode=false;
          $('protectBtn').textContent='Passwortschutz';
          queueFileWrite();refreshStatus();
        }catch(e){alert('Passwort falsch oder Speichern fehlgeschlagen.');}
      }
    }
    async function exportBackup() {
      if(locked)return;
      try{
        await flushPending();
        let value=currentWrapper;
        if(!storageOK||!value||preventOverwrite){
          if(protectMode){
            if(!encryptionKey)throw new Error('Bitte Tagebuch zuerst entsperren.');
            const cipher=await encrypt(toCompact(),encryptionKey);
            value=wrapped(cipher.payload,true,{salt:encryptionSalt,iv:cipher.iv});
          } else value=wrapped(toCompact(),false);
        }
        newBackupFile(backupName(),value);
      }catch(e){alert('Sicherung konnte nicht erstellt werden: '+e.message);}
    }
    async function importBackup(file) {
      if(!file)return;
      try {
        if(file.size>3_000_000)throw new Error('Datei zu groß.');
        const str=await file.text();
        let map,importedKey=null,importedSalt=null,importProtected=false;
        try {
          const wrapper=readWrapper(str);
          if(wrapper.encrypted) {
            const password=await askPassword('Geschützte Sicherung öffnen','Passwort der ausgewählten Sicherungsdatei eingeben.');
            if(password===null)return;
            importedKey=await deriveKey(password,b64ToBytes(wrapper.salt));
            map=fromCompact(JSON.parse(await decrypt(wrapper,importedKey)));
            importedSalt=wrapper.salt;importProtected=true;
          }else {
            map=fromCompact(JSON.parse(wrapper.payload));
          }
        }catch(e) {
          // If it looks like a v2 wrapper, do not mistake corruption for a legacy export.
          const parsed=JSON.parse(str);
          if(parsed?.version===2)throw new Error('Sicherung ungültig oder Passwort falsch.');
          map=fromLegacy(parsed);
        }
        if(!confirm('Die aktuellen Messwerte durch diese Sicherungsdatei ersetzen?'))return;
        await flushPending();
        const prev={records:state.records,key:encryptionKey,salt:encryptionSalt,mode:protectMode};
        state.records=map;
        if(importProtected){encryptionKey=importedKey;encryptionSalt=importedSalt;protectMode=true;}
        try {
          if(protectMode) {
            const cipher=await encrypt(toCompact(),encryptionKey);
            if(!await commitWrapper(wrapped(cipher.payload,true,{salt:encryptionSalt,iv:cipher.iv}),true))throw new Error('Speichern fehlgeschlagen.');
          }else {
            if(!await commitWrapper(wrapped(toCompact(),false),true))throw new Error('Speichern fehlgeschlagen.');
          }
          preventOverwrite=false;
          setLockedUI(false);
          render();queueFileWrite();
        }catch(e){state.records=prev.records;encryptionKey=prev.key;encryptionSalt=prev.salt;protectMode=prev.mode;throw e;}
      }catch(e){alert('Sicherungsdatei konnte nicht geöffnet werden: '+e.message);}
    }

    // Open the options on desktop; on mobile keep them collapsed so the table is visible immediately.
    const optionsPanel=$('optionsPanel');
    const smallScreen=window.matchMedia('(max-width:760px)');
    optionsPanel.open=!smallScreen.matches;
    const syncOptions=event=>{if(!event.matches)optionsPanel.open=true;};
    if(typeof smallScreen.addEventListener==='function')smallScreen.addEventListener('change',syncOptions);
    else if(typeof smallScreen.addListener==='function')smallScreen.addListener(syncOptions);
    initWeekPicker();
    $('weekNumber').addEventListener('change',chooseFallbackWeek);
    $('weekYear').addEventListener('change',()=>{
      setWeekOptions(Number($('weekYear').value),Number($('weekNumber').value));
      chooseFallbackWeek();
    });
    $('selectedWeek').addEventListener('change',e=>{
      const monday=weekFromValue(e.target.value);
      if(monday){state.selectedDate=monday;render();}
      else{$('selectedWeek').value=isoWeekValue(state.selectedDate);alert('Bitte eine gültige Kalenderwoche auswählen.');}
    });
    $('prevWeek').addEventListener('click',()=>{state.selectedDate=dayOffset(weekStart(state.selectedDate),-7);render();});
    $('nextWeek').addEventListener('click',()=>{state.selectedDate=dayOffset(weekStart(state.selectedDate),7);render();});
    $('currentWeekBtn').addEventListener('click',()=>{state.selectedDate=localToday();render();});
    $('dayList').addEventListener('input',e=>{if(e.target.dataset.field && e.target.dataset.field!=='time')updateField(e.target);});
    $('dayList').addEventListener('change',e=>{if(e.target.dataset.field)updateField(e.target);});
    $('dayList').addEventListener('click',e=>{
      const b=e.target.closest('button[data-action]');if(!b)return;
      const date=b.closest('[data-date]')?.dataset.date;if(!date)return;
      const rec=state.records.get(date)||emptyRecord(date);
      if(b.dataset.action==='toggle') {
        rec.collapsed=!rec.collapsed;
        // Collapse states are intentionally not stored: they are not health data.
        const card=b.closest('.day-card');card.classList.toggle('collapsed',rec.collapsed);
        b.setAttribute('aria-expanded',String(!rec.collapsed));b.querySelector('svg')?.classList.toggle('rotate',rec.collapsed);
        if(state.records.has(date))state.records.get(date).collapsed=rec.collapsed;
      }
      if(b.dataset.action==='clear' && confirm('Alle Messwerte und Notizen vom '+dateShort.format(dateObj(date))+' zurücksetzen?')){
        state.records.delete(date);render();persist();
      }
    });
    $('printBtn').addEventListener('click',()=>{if(buildPrintReport())requestAnimationFrame(()=>window.print());});
    $('backupBtn').addEventListener('click',()=>void exportBackup());
    $('importBtn').addEventListener('click',()=>$('importFile').click());
    $('importFile').addEventListener('change',async e=>{await importBackup(e.target.files?.[0]);e.target.value='';});
    $('protectBtn').addEventListener('click',()=>void toggleProtection());
    $('linkFileBtn').addEventListener('click',()=>void connectFile());
    window.addEventListener('beforeunload',e=>{
      if(pending||saving||!storageOK){e.preventDefault();e.returnValue='';}
    });
    window.addEventListener('storage',e=>{
      if(e.key===STORE&&e.newValue!==currentWrapper){message('In einem anderen Fenster geändert: bitte Seite neu laden.',true);}
    });

    async function registerOfflineApp() {
      if(!('serviceWorker' in navigator) || location.protocol!=='https:' && location.hostname!=='localhost')return;
      try { await navigator.serviceWorker.register('./sw.js',{scope:'./'}); }
      catch(e){console.warn('Offline-Installation derzeit nicht verfügbar',e);}
      if(navigator.storage?.persist) {
        // Best-effort request: Safari may ignore it; independent backups are still needed.
        try {await navigator.storage.persist();}catch(_){}
      }
    }
    async function start() {
      state.selectedDate=localToday();
      const existing=await loadExisting();
      if(locked) {
        setLockedUI(true);
        render();
        void unlock(existing);
      } else {
        render();
        if(!existing || (recoveredFrom && state.records.size)) persist();
        refreshStatus();
        if(recoveredFrom){message(recoveredFrom+' Lokale Speicherung aktiv.');}
      }
      void restoreLinkedFile();
      void registerOfflineApp();
    }
    void start();
  })();

  
