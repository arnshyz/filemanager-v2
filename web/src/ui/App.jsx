
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/button'
import { Input } from './components/input'
import { Card } from './components/card'

const STORAGE_KEYS = {
  apiBase: 'telefile.apiBase',
  dataBase: 'telefile.dataBase'
};

const RUNTIME_CONFIG = (() => {
  if (typeof window === 'undefined') return { apiBase: '', dataBase: '' };
  const config = window.__TELEFILE_CONFIG__ || {};
  const params = new URLSearchParams(window.location.search);
  const readStored = (key) => {
    try {
      const storageKey = STORAGE_KEYS[key];
      if (!storageKey) return null;
      const value = window.localStorage?.getItem(storageKey);
      return value === null ? null : value;
    } catch {
      return null;
    }
  };
  const writeStored = (key, value) => {
    try {
      const storageKey = STORAGE_KEYS[key];
      if (!storageKey) return;
      const trimmed = (value || '').trim();
      if (trimmed) window.localStorage?.setItem(storageKey, trimmed);
      else window.localStorage?.removeItem(storageKey);
    } catch {}
  };
  const resolve = (key, configKey, envValue) => {
    let value = null;
    if (params.has(key)) {
      value = params.get(key) || '';
      writeStored(key, value);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete(key);
        window.history.replaceState({}, '', url);
      } catch {}
    } else {
      value = readStored(key);
    }
    if (value === null || value === undefined) value = config?.[configKey] ?? null;
    if (value === null || value === undefined || value === '') value = envValue ?? '';
    return (value || '').trim();
  };
  const apiBase = resolve('apiBase', 'apiBaseUrl', import.meta.env.VITE_API_BASE_URL);
  let dataBase = resolve('dataBase', 'dataBaseUrl', import.meta.env.VITE_DATA_BASE_URL);
  if (!dataBase) dataBase = apiBase;
  return { apiBase, dataBase };
})();

const trimTrailingSlash = (value='') => value.replace(/\/+$/, '');
const API_BASE = trimTrailingSlash(RUNTIME_CONFIG.apiBase);
const DATA_BASE = trimTrailingSlash(RUNTIME_CONFIG.dataBase || API_BASE);

const persistRuntimeConfig = (updates) => {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    Object.entries(updates).forEach(([key, value]) => {
      const storageKey = STORAGE_KEYS[key];
      if (!storageKey) return;
      const trimmed = (value || '').trim();
      try {
        if (trimmed) window.localStorage?.setItem(storageKey, trimmed);
        else window.localStorage?.removeItem(storageKey);
      } catch {}
      if (trimmed) url.searchParams.set(key, trimmed);
      else url.searchParams.delete(key);
    });
    window.history.replaceState({}, '', url);
  } catch {}
};

const applyRuntimeConfig = (updates) => {
  if (typeof window === 'undefined') return;
  persistRuntimeConfig(updates);
  window.location.reload();
};
const resolveUrl = (base, url) => {
  if (!url) return url;
  if (/^https?:/i.test(url)) return url;
  const prefix = base ? base : '';
  const needsSlash = url.startsWith('/') || !prefix;
  return needsSlash ? `${prefix}${url}` : `${prefix}/${url}`;
};

const apiFetch = async (url, opts={})=>{
  const target = resolveUrl(API_BASE, url);
  const res = await fetch(target, { credentials:'include', ...opts });
  if (res.ok) return res;
  let message = res.status === 401 ? 'unauthorized' : 'request failed';
  try {
    const data = await res.clone().json();
    if (data?.error) message = data.error;
  } catch {
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {}
  }
  const error = new Error(message || 'request failed');
  error.status = res.status;
  throw error;
};

const api = {
  me: async ()=> (await apiFetch('/api/auth/me')).json(),
  login: async (username,password)=> (await apiFetch('/api/auth/login',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username,password})})).json(),
  guest: async ()=> (await apiFetch('/api/auth/guest',{ method:'POST' })).json(),
  logout: async ()=> (await apiFetch('/api/auth/logout',{ method:'POST'})).json(),
  list: async (p='/', sort='name', dir='asc' ) => {
    const res = await apiFetch(`/api/files?path=${encodeURIComponent(p)}&sort=${sort}&dir=${dir}`);
    const data = await res.json();
    if (Array.isArray(data?.items)) {
      data.items = data.items.map(item => item?.url ? { ...item, url: resolveUrl(DATA_BASE, item.url) } : item);
    }
    return data;
  },
  upload: async (files, folder='/uploads') => {
    const fd = new FormData();
    [...files].forEach(f => fd.append('files', f));
    const res = await apiFetch(`/api/upload?path=${encodeURIComponent(folder)}`, { method:'POST', body: fd });
    const data = await res.json();
    if (Array.isArray(data?.files)) {
      data.files = data.files.map(file => file?.url ? { ...file, url: resolveUrl(DATA_BASE, file.url) } : file);
    }
    return data;
  },
  mkfolder: async (basePath, name) => {
    const res = await apiFetch(`/api/folder`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: basePath, name }) });
    return res.json();
  },
  del: async (p) => {
    const res = await apiFetch(`/api/files?path=${encodeURIComponent(p)}`, { method:'DELETE' });
    return res.json();
  },
  rename: async (from,to)=> (await apiFetch('/api/rename',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({from,to})})).json(),
  move: async (p,targetDir)=> (await apiFetch('/api/move',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path:p, targetDir})})).json()
}

function useAuth(){
  const [user,setUser] = useState(null);
  const [ready,setReady] = useState(false);
  const [error,setError] = useState('');
  useEffect(()=>{
    let cancelled = false;
    (async ()=>{
      try {
        const data = await api.me();
        if (!cancelled) setUser(data.user);
      } catch (err) {
        try {
          const guest = await api.guest();
          if (!cancelled) setUser(guest.user);
        } catch (guestErr) {
          if (!cancelled) setError(guestErr?.message || 'Tidak dapat masuk.');
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return ()=>{ cancelled = true };
  },[]);
  return { user, ready, error };
}

const ErrorState = ({ message }) => {
  const [apiBaseValue, setApiBaseValue] = useState(RUNTIME_CONFIG.apiBase || '');
  const [dataBaseValue, setDataBaseValue] = useState(RUNTIME_CONFIG.dataBase || '');

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="max-w-lg w-full space-y-4">
        <div>
          <div className="text-lg font-semibold mb-1">Tidak dapat terhubung</div>
          <p className="text-sm text-neutral-400">{message || 'Terjadi kesalahan saat menghubungi server.'}</p>
        </div>
        <div className="space-y-2 text-sm text-neutral-300">
          <p>Pastikan backend berjalan dan endpoint <code>/api/health</code> dapat diakses.</p>
          <p>Bila frontend dan backend berada di host berbeda, isi URL backend di bawah lalu muat ulang.</p>
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">API Base URL</label>
          <Input placeholder="https://backend.example.com" value={apiBaseValue} onChange={e=>setApiBaseValue(e.target.value)} />
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">Data Base URL (opsional)</label>
          <Input placeholder="Kosongkan untuk mengikuti API" value={dataBaseValue} onChange={e=>setDataBaseValue(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={()=>applyRuntimeConfig({ apiBase: '', dataBase: '' })}>Reset</Button>
          <Button onClick={()=>applyRuntimeConfig({ apiBase: apiBaseValue, dataBase: dataBaseValue })}>Simpan &amp; muat ulang</Button>
        </div>
        <div className="text-xs text-neutral-500 space-y-1">
          <p>Pengaturan ini disimpan di <code>localStorage</code> dan juga dapat diubah melalui <code>web/public/config.js</code>.</p>
          <p>Alternatif cepat: tambahkan query <code>?apiBase=https://backend.example.com</code> pada URL.</p>
        </div>
      </Card>
    </div>
  );
};

const FileIcon = ({mime,isDir}) => {
  if (isDir) return <span>📁</span>
  if (mime?.startsWith('image/')) return <span>🖼️</span>
  if (mime?.startsWith('video/')) return <span>🎬</span>
  if (mime?.startsWith('audio/')) return <span>🎵</span>
  if (mime==='application/pdf') return <span>📄</span>
  return <span>📦</span>
}

function useFiles() {
  const [cwd, setCwd] = useState('/');
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState('asc');
  const [state, setState] = useState({ items: [], breadcrumb: [] });
  const [q, setQ] = useState('');
  async function refresh(p=cwd, s=sort, d=dir) {
    const data = await api.list(p,s,d);
    setState(data); setCwd(p); setSort(s); setDir(d);
  }
  const reorder = (s)=>{
    const d = sort===s && dir==='asc' ? 'desc':'asc';
    setDir(d); setSort(s); refresh(cwd,s,d);
  }
  useEffect(()=>{ refresh('/') },[]);
  const filtered = useMemo(()=>{
    if (!q) return state.items;
    const s = q.toLowerCase();
    return state.items.filter(it=>it.name.toLowerCase().includes(s));
  },[q,state]);
  return { cwd, setCwd, state, filtered, refresh, q, setQ, sort, dir, reorder };
}

const Preview = ({file}) => {
  if (!file || file.isDir) return <div className="text-neutral-400">Pilih file untuk preview</div>
  const url = file.url;
  if (file.mime?.startsWith('image/')) return <img src={url} alt={file.name} className="w-full h-full object-contain rounded-lg" />
  if (file.mime?.startsWith('video/')) return <video controls src={url} className="w-full h-full object-contain rounded-lg"></video>
  if (file.mime?.startsWith('audio/')) return <audio controls src={url} className="w-full w-full"></audio>
  if (file.mime==='application/pdf') return <iframe src={url} className="w-full h-full rounded-lg"></iframe>
  if (file.mime?.startsWith('text/')) return <iframe src={url} className="w-full h-full rounded-lg"></iframe>
  return <a className="btn btn-primary inline-block" href={url} download>Download</a>
}

export default function App(){
  const { user, ready, error } = useAuth();
  const { cwd, state, filtered, refresh, q, setQ, sort, dir, reorder } = useFiles();
  const [sel, setSel] = useState(null);
  const [folderName, setFolderName] = useState('');
  const inputRef = useRef(null);

  const go = (name) => {
    const p = (cwd.endsWith('/')?cwd:cwd+'/') + name;
    setSel(null); refresh(p);
  }
  const up = () => {
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length===0) return;
    const p = '/' + parts.slice(0,-1).join('/');
    setSel(null); refresh(p);
  }
  if (!ready) return null;
  if (error) return <ErrorState message={error} />;
  if (!user) return null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 glass p-4 border-b border-neutral-800">
        <div className="max-w-7xl mx-auto flex items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <div className="text-xl font-bold">TeleFile v2</div>
            <Button variant="ghost" onClick={up}>Naik</Button>
            <div className="text-sm text-neutral-400 truncate max-w-[480px]">{cwd}</div>
          </div>
          <div className="flex items-center gap-2">
            <Input placeholder="Cari..." value={q} onChange={e=>setQ(e.target.value)} />
            <label className="btn btn-ghost cursor-pointer">
              Upload
              <input type="file" multiple hidden ref={inputRef} onChange={async e=>{
                await api.upload(e.target.files, cwd || '/uploads');
                await refresh(cwd);
                e.target.value = '';
              }}/>
            </label>
            <Button variant="outline" onClick={async ()=>{ await api.logout(); location.reload(); }}>Keluar</Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 grid grid-cols-12 gap-4">
        <section className="col-span-8 card p-0 overflow-hidden">
          <table>
            <thead>
              <tr>
                <th>Nama <button className="text-xs underline" onClick={()=>reorder('name')}>{sort==='name'?dir:''}</button></th>
                <th>Ukuran <button className="text-xs underline" onClick={()=>reorder('size')}>{sort==='size'?dir:''}</button></th>
                <th>Terakhir diubah <button className="text-xs underline" onClick={()=>reorder('mtime')}>{sort==='mtime'?dir:''}</button></th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it)=>(
                <tr key={it.name} className="hover:bg-neutral-900">
                  <td className="cursor-pointer" onClick={()=> it.isDir ? go(it.name) : setSel(it)}>
                    <span className="mr-2 text-lg">{it.isDir?'📁':(it.mime?.startsWith('image/')?'🖼️':it.mime?.startsWith('video/')?'🎬':it.mime?.startsWith('audio/')?'🎵':it.mime==='application/pdf'?'📄':'📦')}</span>{it.name}
                  </td>
                  <td>{it.isDir ? '-' : it.size}</td>
                  <td>{new Date(it.mtime).toLocaleString()}</td>
                  <td className="space-x-2">
                    {!it.isDir && <a className="text-sm underline" href={it.url} target="_blank">Buka</a>}
                    {!it.isDir && <button className="text-sm underline" onClick={()=>{
                      const target = (() => {
                        try { return new URL(it.url, window.location.origin).toString(); }
                        catch { return it.url; }
                      })();
                      navigator.clipboard.writeText(target);
                    }}>Copy link</button>}
                    <button className="text-sm underline" onClick={async ()=>{
                      const to = (cwd.endsWith('/')?cwd:cwd+'/') + prompt('Nama baru:', it.name);
                      if (!to) return;
                      await api.rename((cwd.endsWith('/')?cwd:cwd+'/')+it.name, to);
                      await refresh(cwd);
                    }}>Rename</button>
                    <button className="text-sm underline" onClick={async ()=>{
                      const targetDir = prompt('Pindah ke folder:', '/uploads');
                      if (!targetDir) return;
                      await api.move((cwd.endsWith('/')?cwd:cwd+'/')+it.name, targetDir);
                      await refresh(cwd);
                    }}>Pindah</button>
                    <button className="text-sm underline text-red-400" onClick={async ()=>{
                      if (!confirm('Hapus?')) return;
                      await api.del((cwd.endsWith('/')?cwd:cwd+'/')+it.name);
                      await refresh(cwd);
                    }}>Hapus</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="col-span-4 flex flex-col gap-3">
          <Card className="h-80">{ sel ? <Preview file={sel} /> : <div className="text-neutral-400">Pilih file untuk preview</div> }</Card>
          <Card>
            <div className="font-semibold mb-2">Folder Baru</div>
            <div className="flex gap-2">
              <Input placeholder="nama-folder" value={folderName} onChange={e=>setFolderName(e.target.value)} />
              <Button onClick={async ()=>{ if (!folderName) return; await api.mkfolder(cwd, folderName); setFolderName(''); await refresh(cwd); }}>Buat</Button>
            </div>
          </Card>
          <Card>
            <div className="font-semibold mb-1">Integrasi Telegram</div>
            <p className="text-sm text-neutral-400">Set <code>.env</code> dengan <code>BOT_TOKEN</code>. Kirim file ke bot. File disimpan di <code>/data/telegram/&lt;tanggal&gt;/</code> lalu dibalas link publik.</p>
          </Card>
        </aside>
      </main>
      <footer className="text-center text-neutral-500 text-sm p-6">TeleFile v2</footer>
    </div>
  )
}
