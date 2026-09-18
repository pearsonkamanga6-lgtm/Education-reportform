(() => {
  let deferredPrompt = null;
  let reloading = false;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  function tools(){let x=document.getElementById('pwaTools');if(!x){x=document.createElement('div');x.id='pwaTools';x.style.cssText='position:fixed;left:10px;bottom:74px;z-index:9998;display:flex;gap:7px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 20px)';document.body.appendChild(x)}return x}
  function connectivity(){const w=tools();let b=document.getElementById('networkBadge');if(!b){b=document.createElement('div');b.id='networkBadge';b.style.cssText='padding:6px 9px;border-radius:999px;font:700 10px system-ui;box-shadow:0 6px 20px #0002;border:1px solid #dbe3ef';w.appendChild(b)}if(navigator.onLine){b.textContent='● Online';b.style.background='#ecfdf3';b.style.color='#067647'}else{b.textContent='● Offline — live submissions paused';b.style.background='#fff4e5';b.style.color='#9a3412'}}
  function installButton(){const w=tools();let b=document.getElementById('installEduSend');if(isStandalone()){b?.remove();return}if(!deferredPrompt)return;if(!b){b=document.createElement('button');b.id='installEduSend';b.textContent='Install EduSend';b.style.cssText='border:0;background:#0b2f6b;color:#fff;padding:8px 12px;border-radius:999px;font:700 11px system-ui;box-shadow:0 8px 24px #0003';b.onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice.catch(()=>null);deferredPrompt=null;installButton()};w.appendChild(b)}}

  addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;installButton()});
  addEventListener('appinstalled',()=>{deferredPrompt=null;document.getElementById('installEduSend')?.remove()});
  addEventListener('online',connectivity);addEventListener('offline',connectivity);

  if('serviceWorker' in navigator){
    addEventListener('load', async()=>{
      try{
        const reg=await navigator.serviceWorker.register('/service-worker.js',{updateViaCache:'none'});
        await reg.update().catch(()=>{});
        setInterval(()=>reg.update().catch(()=>{}),5*60*1000);
      }catch(e){console.warn('Service worker registration failed',e)}
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloading)return;reloading=true;location.reload()});
    navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.type==='EDUSEND_UPDATED'&&!reloading){reloading=true;location.reload()}});
  }
  connectivity();
})();
