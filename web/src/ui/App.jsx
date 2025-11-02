
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/button'
import { Input } from './components/input'
import { Card } from './components/card'

const apiFetch = async (url, opts={})=>{
  const res = await fetch(url, { credentials:'include', ...opts });
  if (res.status===401) throw new Error('unauthorized');
  return res;
};

const api = {
  me: async ()=> (await apiFetch('/api/auth/me')).json(),
  login: async (username,password)=> (await apiFetch('/api/auth/login',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username,password})})).json(),
  logout: async ()=> (await apiFetch('/api/auth/logout',{ method:'POST'})).json(),
  list: async (p='/', sort='name', dir='asc' ) => (await apiFetch(`/api/files?path=${encodeURIComponent(p)}&sort=${sort}&dir=${dir}`)).json(),
  upload: async (files, folder='/uploads') => {
    const fd = new FormData();
    [...files].forEach(f => fd.append('files', f));
    const res = await apiFetch(`/api/upload?path=${encodeURIComponent(folder)}`, { method:'POST', body: fd });
    return res.json();
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
  useEffect(()=>{ api.me().then(d=>{ setUser(d.user); setReady(true) }).catch(()=> setReady(true)); },[]);
  return { user, setUser, ready };
}

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

function Login({onLogged}){
  const [u,setU] = useState('admin');
  const [p,setP] = useState('admin12345');
  const [err,setErr] = useState('');
  return (
    <div className="min-h-screen grid place-content-center">
      <Card className="w-[380px]">
        <div className="text-xl font-bold mb-2">Masuk</div>
        <div className="text-sm text-neutral-400 mb-4">Gunakan kredensial admin dari .env</div>
        <div className="space-y-3">
          <Input value={u} onChange={e=>setU(e.target.value)} placeholder="username" />
          <Input value={p} onChange={e=>setP(e.target.value)} type="password" placeholder="password" />
          {err && <div className="text-red-400 text-sm">{err}</div>}
          <Button onClick={async ()=>{
            setErr('');
            try{ const res = await api.login(u,p); onLogged(res.user); }
            catch(e){ setErr('Gagal login'); }
          }}>Masuk</Button>
        </div>
      </Card>
    </div>
  )
}

export default function App(){
  const { user, setUser, ready } = useAuth();
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
  if (!user) return <Login onLogged={setUser} />;

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
                    {!it.isDir && <button className="text-sm underline" onClick={()=>navigator.clipboard.writeText(location.origin+it.url)}>Copy link</button>}
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
