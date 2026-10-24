/** Local deterministic API responses for the installed native clients. Never forwards requests. */
export function protectedProviderApi(protocol: 'claude' | 'codex' | 'muse', actions: {name: string; input: unknown; custom?: boolean; namespace?: string}[], skipTools: (body: unknown) => boolean = () => false) {
  const requests: unknown[] = [];
  const authorizations: string[] = [];
  let stage = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/models')) {
      return Response.json({data: []});
    }
    if (url.pathname.endsWith('/count_tokens')) return Response.json({input_tokens: 1});
    if (!url.pathname.endsWith('/messages') && !url.pathname.endsWith('/responses')) return Response.json({error: 'fixture endpoint'}, {status: 404});
    const body = await request.json(); requests.push(body);
    authorizations.push(request.headers.get('authorization') ?? request.headers.get('x-api-key') ?? '');
    const action = skipTools(body) ? undefined : actions.shift(); stage++;
    const id = `fixture_${stage}`;
    const events: {type: string; [key: string]: unknown}[] = [];
    if (protocol === 'claude') {
      const block = action ? {type: 'tool_use', id, name: action.name, input: {}} : {type: 'text', text: ''};
      events.push({type: 'message_start', message: {id, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1}}},
        {type: 'content_block_start', index: 0, content_block: block},
        {type: 'content_block_delta', index: 0, delta: action ? {type: 'input_json_delta', partial_json: JSON.stringify(action.input)} : {type: 'text_delta', text: 'Protected fixture completed'}},
        {type: 'content_block_stop', index: 0},
        {type: 'message_delta', delta: {stop_reason: action ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: 1}}, {type: 'message_stop'});
    } else {
      const item = action ? (action.custom ? {type: 'custom_tool_call', id, call_id: id, name: action.name, input: action.input}
        : {type: 'function_call', id, call_id: id, name: action.name, ...(action.namespace ? {namespace: action.namespace} : {}), arguments: JSON.stringify(action.input)})
        : {type: 'message', id, role: 'assistant', status: 'completed', ...(protocol === 'muse' ? {phase: 'final_answer'} : {}), content: [{type: 'output_text', text: 'Protected fixture completed', annotations: []}]};
      const response = {id, object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', model: 'gpt-6.1-sol', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}};
      events.push({type: 'response.created', response: {...response, status: 'in_progress', output: []}},
        {type: 'response.output_item.added', output_index: 0, item: action ? {...item, arguments: ''} : {...item, content: []}},
        ...(action && !action.custom ? [{type: 'response.function_call_arguments.delta', item_id: id, output_index: 0, delta: JSON.stringify(action.input)},
          {type: 'response.function_call_arguments.done', item_id: id, output_index: 0, arguments: JSON.stringify(action.input)}] : []),
        ...(!action ? [{type: 'response.content_part.added', item_id: id, output_index: 0, content_index: 0, part: {type: 'output_text', text: '', annotations: []}},
          {type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: 'Protected fixture completed'},
          {type: 'response.output_text.done', item_id: id, output_index: 0, content_index: 0, text: 'Protected fixture completed'},
          {type: 'response.content_part.done', item_id: id, output_index: 0, content_index: 0, part: {type: 'output_text', text: 'Protected fixture completed', annotations: []}}] : []),
        {type: 'response.output_item.done', output_index: 0, item}, {type: 'response.completed', response});
    }
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({...event, sequence_number})}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
  }});
  return {url: `http://127.0.0.1:${server.port}`, requests, authorizations, enqueue: (...next: typeof actions) => actions.push(...next), stop: () => server.stop(true)};
}
