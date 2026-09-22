/** Synthetic workflow with search, navigation, delayed fields and a review/edit cycle. */
export function invoiceFixture() {
  const searches: string[] = [];
  const opened: string[] = [];
  const reviews: unknown[] = [];
  const submissions: unknown[] = [];
  const expected = { invoice: 'INV-204', recipient: 'Alice', payment: 'Bank transfer', reference: 'TEAM-42', reminders: false };
  const firstReview = { ...expected, recipient: 'Ada' };
  const goal = 'Search for invoice INV-204 and open the exact invoice, not INV-2040. Set Recipient to Ada, choose Bank transfer, enter TEAM-42 in Payment reference after it appears, and turn off Send reminders. Open Review invoice, then use Edit invoice to change Recipient to Alice. Review the corrected invoice and Confirm invoice exactly once.';
  const values = { invoice: 'INV-204', firstRecipient: 'Ada', payment: 'Bank transfer', reference: 'TEAM-42', finalRecipient: 'Alice' };
  const shell = (body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Invoice workspace</title>
    <style>body{font:18px/1.5 system-ui;margin:0;background:#f6f7f9;color:#18212b}main{max-width:780px;margin:28px auto}small{color:#526174}h1{font-size:30px;margin:8px 0 18px}h2{font-size:22px}section,form{padding:22px;background:white;border:1px solid #cbd2db;border-radius:10px}label{display:block;margin-bottom:14px}input:not([type=checkbox]),select{display:block;box-sizing:border-box;width:100%;padding:8px 12px;font:inherit;border:1px solid #8b99aa;border-radius:5px}input[type=checkbox]{width:19px;height:19px;margin-right:9px;accent-color:#1856b5}button,a{font:inherit}button{padding:9px 17px;background:#1856b5;color:white;border:0;border-radius:5px;margin-right:12px}a{display:block;padding:15px;color:#1856b5}pre{white-space:pre-wrap;font-size:16px}input:focus,select:focus,button:focus{outline:3px solid #a2c3f3;outline-offset:2px}.saved{background:#e2f3e8;padding:18px}</style>
    <main><small>LOCAL TEST PAGE · REAL JEV EXECUTION</small>${body}</main></html>`;
  const html = (body: string) => new Response(shell(body), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/review') {
      reviews.push(await request.json());
      return Response.json({ review: reviews.length });
    }
    if (request.method === 'POST' && url.pathname === '/confirm') {
      submissions.push(await request.json());
      return Response.json({ saved: submissions.at(-1), submissions: submissions.length });
    }
    if (url.pathname === '/search') {
      searches.push(url.searchParams.get('q') ?? '');
      await Bun.sleep(400);
      return html('<h1>Invoice search results</h1><section><a href="/invoice/INV-2040">INV-2040 · Northwind · Draft</a><a href="/invoice/INV-204">INV-204 · Contoso · Draft</a></section>');
    }
    if (url.pathname.startsWith('/invoice/')) {
      const invoice = url.pathname.split('/').at(-1)!;
      opened.push(invoice);
      if (invoice !== expected.invoice) return html('<h1>Wrong invoice</h1><a href="/">Back to search</a>');
      return html(`<h1>Invoice ${invoice}</h1><div id="view"></div><script>
        const data={invoice:'INV-204',recipient:'',payment:'Card',reference:'',reminders:true};
        let reviewCount=0, previousRecipient='';
        const view=document.querySelector('#view');
        function edit(){
          view.innerHTML='<form><h2>Edit invoice</h2><p id="history"></p><label>Recipient<input name="recipient" autocomplete="off"></label><label>Payment method<select name="payment"><option>Card</option><option>Bank transfer</option></select></label><div id="reference"></div><label><input name="reminders" type="checkbox">Send reminders</label><button>Review invoice</button></form>';
          const f=view.querySelector('form');
          f.recipient.value=data.recipient;f.payment.value=data.payment;f.reminders.checked=data.reminders;
          if(reviewCount)document.querySelector('#history').textContent='Previous review '+reviewCount+': Recipient '+previousRecipient;
          const reference=()=>{const target=document.querySelector('#reference');target.innerHTML='';if(data.payment==='Bank transfer'){target.textContent='Loading bank transfer details';setTimeout(()=>{target.innerHTML='<label>Payment reference<input name="reference" autocomplete="off"></label>';f.reference.value=data.reference;f.reference.oninput=()=>data.reference=f.reference.value;},350);}};
          f.recipient.oninput=()=>data.recipient=f.recipient.value;
          f.payment.onchange=()=>{data.payment=f.payment.value;reference();};
          f.reminders.onchange=()=>data.reminders=f.reminders.checked;
          f.onsubmit=async e=>{e.preventDefault();const r=await(await fetch('/review',{method:'POST',body:JSON.stringify(data)})).json();reviewCount=r.review;previousRecipient=data.recipient;review();};
          reference();
        }
        function review(){
          view.innerHTML='<section><h2>Review invoice</h2><p id="count"></p><pre></pre><button id="edit">Edit invoice</button><button id="confirm">Confirm invoice</button></section>';
          view.querySelector('#count').textContent='Review '+reviewCount;
          view.querySelector('pre').textContent=JSON.stringify(data,null,2);
          view.querySelector('#edit').onclick=edit;
          view.querySelector('#confirm').onclick=async()=>{const r=await(await fetch('/confirm',{method:'POST',body:JSON.stringify(data)})).json();view.innerHTML='<section class="saved"><h2>Invoice confirmed</h2><pre></pre></section>';view.querySelector('pre').textContent=JSON.stringify(r.saved)+String.fromCharCode(10)+'Submissions: '+r.submissions;};
        }
        edit();
      </script>`);
    }
    return html('<h1>Invoices</h1><form action="/search"><label>Search invoice<input name="q" autocomplete="off"></label><button>Search</button></form>');
  } });
  return { server, url: `http://127.0.0.1:${server.port}`, searches, opened, reviews, submissions, expected, firstReview, goal, values };
}
