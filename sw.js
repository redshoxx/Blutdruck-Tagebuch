// Caches ONLY the offline application shell; blood pressure records stay in IndexedDB.
const CACHE='blutdruck-pwa-shell-v5';
const ASSETS=['./index.html','./styles.css','./app.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-512-maskable.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('blutdruck-pwa-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  const inScope=url.pathname.startsWith(new URL(self.registration.scope).pathname);
  if(!inScope)return;
  if(req.mode==='navigate'){
    // Fetch current UI when online; always retain a usable offline shell.
    event.respondWith(fetch(req).then(async response=>{
      if(!response.ok)return response;
      const cache=await caches.open(CACHE);
      await cache.put('./index.html',response.clone());
      return response;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  const file=url.pathname.slice(new URL(self.registration.scope).pathname.length);
  const known=ASSETS.some(path=>path.slice(2)===file);
  if(!known)return;
  // Network-first for version consistency; cached CSS/JS/icons on airplane mode.
  event.respondWith(fetch(req).then(async response=>{
    if(response.ok){const cache=await caches.open(CACHE);await cache.put(req,response.clone());}
    return response;
  }).catch(()=>caches.match(req)));
});
