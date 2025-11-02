
export function Button({ variant='default', className='', ...props }) {
  const base = 'px-4 py-2 rounded-xl transition';
  const variants = {
    default: 'bg-white text-black hover:bg-neutral-200',
    ghost: 'bg-neutral-800 hover:bg-neutral-700 text-white',
    outline: 'border border-neutral-700 hover:bg-neutral-900'
  }
  return <button className={base+' '+(variants[variant]||variants.default)+' '+className} {...props} />
}
