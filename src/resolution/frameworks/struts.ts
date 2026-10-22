/**
 * Struts Framework Resolver (Struts 1 struts-config.xml + Struts 2 struts.xml)
 *
 * Struts routes live in XML, not Java source: without the XML side in the
 * graph, an action URL dead-ends before reaching the Action class, and "which
 * URL serves this JSP" can't be answered. This resolver emits one `route`
 * node per `<action>` (Struts2 `<package><action>`, Struts1
 * `<action-mappings><action>`), plus a reference keyed
 * `<class-FQN>::<method>:struts` that `resolve()` links to the Java handler
 * method — mirroring the MyBatis `<namespace>::<id>` Java↔XML bridge.
 *
 * The `:struts` sentinel suffix mirrors springResolver's `:prefix`: a
 * `com.example.LoginAction::doLogin` spelling exists as no node's name, so
 * the resolver's name-existence pre-filter would drop the ref unless
 * `claimsReference` opts it through.
 *
 * `<result>`/`<forward>` JSP locations ride in the route node's docstring
 * rather than placeholder nodes — a JSP is never indexed, and a phantom row
 * in the files table would lie about that. Struts2-convention-plugin
 * `@Action`-annotated Java methods (the routes that live in Java source, not
 * XML) are extracted here too — the Spring `@RequestMapping` path in java.ts
 * is the template for that half.
 *
 * Deliberately unresolved, with a note in the docstring instead of a guess:
 * wildcard/DMI `method="{1}"`, class-less convention actions, Struts1
 * DispatchAction (`parameter="..."` picks the method per-request at runtime),
 * and Spring-plugin bean names in `class` (they name a Spring bean, not a
 * class — resolve() finds nothing and the ref stays unresolved, the honest
 * outcome). `<include file="struts-user.xml"/>` needs no recursion: an
 * included config is itself a struts-named XML file the basename rule picks
 * up on its own; only an oddly-named include is missed.
 */
import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const STRUTS_SUFFIX = ':struts';

/** `name="x"` / `name='x'` — either quote style; `\b` never splits inside a
 * longer attribute name (`actionName=` has no boundary before `name`). */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']+)\\1`).exec(attrs);
  return m ? m[2]! : null;
}

/** Struts config file? Basename first (covers `<include>`-split module configs
 * like struts-user.xml), then the root element for renamed files. `(?![\w-])`
 * rather than `\b` — `-` is a word boundary, so `\b` alone would let `<struts`
 * match `<struts-config` and `<action` match `<action-mappings`. */
function isStrutsConfigFile(filePath: string, content: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  if (/^struts(-config)?(-[\w.-]+)?\.xml$/i.test(base)) return true;
  return /<struts(?![\w-])[\s>]/.test(content) || /<struts-config(?![\w-])[\s>]/.test(content);
}

export const strutsResolver: FrameworkResolver = {
  name: 'struts',
  // 'xml' so extract() sees the config files and resolve() receives the
  // extractor's handler refs (language 'xml'); 'java' for convention-plugin
  // @Action extraction.
  languages: ['xml', 'java'],

  claimsReference(name: string): boolean {
    return name.endsWith(STRUTS_SUFFIX);
  },

  detect(context: ResolutionContext): boolean {
    for (const buildFile of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      const content = context.readFile(buildFile);
      if (content && /struts/i.test(content)) return true;
    }
    // Config files by name — covers multi-module layouts via getAllFiles.
    for (const file of context.getAllFiles()) {
      const base = file.split('/').pop() ?? '';
      if (/^struts(-config)?(-[\w.-]+)?\.xml$/i.test(base) || base === 'struts.properties') {
        return true;
      }
    }
    // Classic WAR layout: the Struts filter/servlet registered in web.xml.
    for (const webXml of ['src/main/webapp/WEB-INF/web.xml', 'webapp/WEB-INF/web.xml', 'WEB-INF/web.xml']) {
      const content = context.readFile(webXml);
      if (content && /struts/i.test(content)) return true;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!ref.referenceName.endsWith(STRUTS_SUFFIX)) return null;
    const target = ref.referenceName.slice(0, -STRUTS_SUFFIX.length);
    const sep = target.lastIndexOf('::');
    if (sep < 0) return null;
    const classFqn = target.slice(0, sep);
    const method = target.slice(sep + 2);
    const simple = classFqn.split('.').pop() ?? classFqn;

    // `class` may be a Spring-plugin bean name rather than a FQN — then no
    // file is named after it, nothing matches, and the ref stays unresolved.
    let candidates = context
      .getNodesByName(method)
      .filter(
        (n) =>
          n.kind === 'method' &&
          n.language === 'java' &&
          n.filePath.endsWith(`/${simple}.java`)
      );
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      // Prefer the node whose path matches the FQN's package layout; a
      // legacy monorepo can hold several same-named Action classes.
      const packagePath = classFqn.includes('.') ? classFqn.replace(/\./g, '/') : null;
      if (packagePath) {
        const exact = candidates.filter((n) => n.filePath.includes(packagePath));
        if (exact.length === 1) {
          return { original: ref, targetNodeId: exact[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
        }
        if (exact.length > 1) return null; // ambiguity — silent beats wrong
      }
      return null;
    }
    return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.85, resolvedBy: 'framework' };
  },

  extract(filePath: string, content: string) {
    if (filePath.endsWith('.java')) {
      return extractConventionActions(filePath, content);
    }
    if (filePath.endsWith('.xml') && isStrutsConfigFile(filePath, content)) {
      return extractStrutsXml(filePath, content);
    }
    return { nodes: [] as Node[], references: [] as UnresolvedRef[] };
  },
};

// ---------------------------------------------------------------------------
// XML side — Struts1 struts-config.xml + Struts2 struts.xml
// ---------------------------------------------------------------------------

/** Length-preserving comment blanking, identical to MyBatisExtractor's: a
 * `<!-- <action ...> -->` block must not produce a phantom route, while the
 * offsets and line numbers computed afterwards still map to the original
 * source. Newlines are kept so line numbers survive. */
function stripXmlComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end >= 0 ? end + 3 : source.length;
      for (let j = i; j < stop; j++) if (source.charCodeAt(j) !== 10) out[j] = ' ';
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

interface ActionResult {
  name: string;
  type?: string | null;
  location: string;
}

interface ActionInput {
  routePath: string;
  className: string | null;
  method: string;
  results: ActionResult[];
  frameworkNote: string;
  formBean?: string | null;
  /** Struts1 DispatchAction: the method is picked by a request parameter at
   * runtime — no statically known handler, so no handler ref is emitted. */
  dispatch?: boolean;
  /** Absolute byte offset of the `<action` tag — node identity input. */
  offset: number;
  /** Absolute byte offset of the action's end (close tag) — endLine. */
  endOffset: number;
}

function extractStrutsXml(filePath: string, rawContent: string): {
  nodes: Node[];
  references: UnresolvedRef[];
} {
  const source = stripXmlComments(rawContent);
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const actions: ActionInput[] = [];

  // Struts2: <package namespace="/x"><action name="y" class="FQN" method="m">
  // Results (the JSP targets) are the action's <result> children.
  const pkgRegex = /<package(?![\w-])([^>]*)>([\s\S]*?)<\/package\s*>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pkgRegex.exec(source)) !== null) {
    const namespace = attr(pm[1]!, 'namespace') ?? '';
    const body = pm[2] ?? '';
    if (!body) continue;
    const bodyOffset = pm.index + pm[0].indexOf(body);
    const actRegex = /<action(?![\w-])([^>]*?)(?:\/>|>([\s\S]*?)<\/action\s*>)/g;
    let am: RegExpExecArray | null;
    while ((am = actRegex.exec(body)) !== null) {
      const attrsStr = am[1] ?? '';
      const name = attr(attrsStr, 'name');
      if (!name) continue;
      actions.push({
        routePath: joinPath(namespace, name),
        className: attr(attrsStr, 'class'),
        method: attr(attrsStr, 'method') ?? 'execute',
        results: collectResults(am[2] ?? ''),
        frameworkNote: 'Struts2',
        offset: bodyOffset + am.index,
        endOffset: bodyOffset + am.index + am[0].length,
      });
    }
  }

  // Struts1: <action-mappings><action path="/x" type="FQN" parameter="p">
  // Forwards are the JSP targets. A `parameter` attribute means DispatchAction
  // — the method is chosen by a request parameter at runtime, statically
  // unresolvable, so no handler ref is emitted (noted in the docstring).
  const mappings = /<action-mappings(?![\w-])[^>]*>([\s\S]*?)<\/action-mappings\s*>/.exec(source);
  if (mappings) {
    const body = mappings[1]!;
    const bodyOffset = mappings.index + mappings[0].indexOf(body);
    const actRegex = /<action(?![\w-])([^>]*?)(?:\/>|>([\s\S]*?)<\/action\s*>)/g;
    let am: RegExpExecArray | null;
    while ((am = actRegex.exec(body)) !== null) {
      const attrsStr = am[1] ?? '';
      const path = attr(attrsStr, 'path');
      if (!path) continue;
      const parameter = attr(attrsStr, 'parameter');
      const results: ActionResult[] = [];
      const fwdRegex = /<forward(?![\w-])([^>]*?)\/?>/g;
      let fm: RegExpExecArray | null;
      while ((fm = fwdRegex.exec(am[2] ?? '')) !== null) {
        const fName = attr(fm[1]!, 'name');
        const fPath = attr(fm[1]!, 'path');
        if (fName && fPath) results.push({ name: fName, location: fPath });
      }
      actions.push({
        routePath: path,
        className: attr(attrsStr, 'type'),
        method: 'execute',
        results,
        frameworkNote: parameter
          ? `Struts1 DispatchAction (parameter="${parameter}") — runtime-dispatched method, not statically resolvable`
          : 'Struts1',
        formBean: attr(attrsStr, 'name'),
        dispatch: Boolean(parameter),
        offset: bodyOffset + am.index,
        endOffset: bodyOffset + am.index + am[0].length,
      });
    }
  }
  const now = Date.now();
  for (const input of actions) {
    const startLine = lineOf(input.offset);
    const endLine = lineOf(input.endOffset);
    const qualified = `${filePath}::route:${input.routePath}`;
    const node: Node = {
      id: `route:${filePath}:${startLine}:ACTION:${input.routePath}`,
      kind: 'route',
      name: `ACTION ${input.routePath}`,
      qualifiedName: qualified,
      filePath,
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      language: 'xml',
      signature: input.className ? `${input.className}#${input.method}` : undefined,
      updatedAt: now,
    };
    const notes: string[] = [input.frameworkNote];
    if (input.formBean) notes.push(`form-bean: ${input.formBean}`);
    const dmi = /\{\d+\}/.test(input.method);
    if (dmi) notes.push(`wildcard/DMI method="${input.method}" — handler not statically resolvable`);
    if (!input.className) notes.push('no class attribute (convention/forward-only) — handler not statically resolvable');
    if (input.results.length > 0) {
      notes.push(
        'results: ' +
          input.results
            .map((r) => `${r.name} → ${r.location}${r.type && r.type !== 'dispatcher' ? ` (${r.type})` : ''}`)
            .join('; ')
      );
    }
    node.docstring = notes.join(' | ').slice(0, 400);
    nodes.push(node);

    // Handler link — skipped for DMI wildcards, DispatchActions, and
    // class-less actions: those have no statically known method to bind.
    if (input.className && !dmi && !input.dispatch) {
      references.push({
        fromNodeId: node.id,
        referenceName: `${input.className}::${input.method}${STRUTS_SUFFIX}`,
        referenceKind: 'references',
        line: startLine,
        column: 0,
        filePath,
        language: 'xml',
      });
    }
  }

  return { nodes, references };
}

/** `<result name="success" type="redirect">/pages/home.jsp</result>` — the
 * location is the body text, or `<param name="location">…</param>` for the
 * non-string result types (stream, redirectAction, …). */
function collectResults(actionBody: string): ActionResult[] {
  const results: ActionResult[] = [];
  const resRegex = /<result(?![\w-])([^>]*?)(?:\/>|>([\s\S]*?)<\/result\s*>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = resRegex.exec(actionBody)) !== null) {
    const rAttrs = rm[1] ?? '';
    const rBody = rm[2] ?? '';
    let location = rBody.trim();
    const param = /<param\s+name=["']location["']\s*>([\s\S]*?)<\/param>/.exec(rBody);
    if (param) location = param[1]!.trim();
    if (!location) continue;
    results.push({
      name: attr(rAttrs, 'name') ?? 'success',
      type: attr(rAttrs, 'type'),
      location,
    });
  }
  return results;
}

function joinPath(namespace: string, action: string): string {
  const parts = [namespace, action].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

// ---------------------------------------------------------------------------
// Java side — struts2-convention-plugin @Action annotations
// ---------------------------------------------------------------------------

function extractConventionActions(filePath: string, content: string): {
  nodes: Node[];
  references: UnresolvedRef[];
} {
  if (!content.includes('@Action')) return { nodes: [], references: [] };
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const safe = stripCommentsForRegex(content, 'java');

  const nsMatch = /@Namespace\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/.exec(safe);
  const ns = nsMatch ? nsMatch[1]! : '';

  const actionRe = /@Action\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = actionRe.exec(safe)) !== null) {
    const line = safe.slice(0, m.index).split('\n').length;
    const routePath =
      '/' +
      [ns.replace(/^\/+|\/+$/g, ''), m[1]!.replace(/^\/+|\/+$/g, '')]
        .filter(Boolean)
        .join('/');

    // Bounded tail: the method it decorates (skip stacked annotations; same
    // window shape as Spring's method scan) and any @Result locations.
    const tail = safe.slice(m.index, m.index + 1200);
    const results = [...tail.matchAll(/@Result\s*\(\s*(?:name\s*=\s*)?"([^"]*)"[^)]*?location\s*=\s*"([^"]*)"/g)]
      .map((r) => `${r[1]} → ${r[2]}`)
      .join('; ');
    const methodMatch = tail.match(/\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
    if (!methodMatch) continue;

    const node: Node = {
      id: `route:${filePath}:${line}:ACTION:${routePath}`,
      kind: 'route',
      name: `ACTION ${routePath}`,
      qualifiedName: `${filePath}::route:${routePath}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: 'java',
      docstring: ['Struts2 convention-plugin', results ? `results: ${results}` : '']
        .filter(Boolean)
        .join(' | ')
        .slice(0, 400),
      updatedAt: now,
    };
    nodes.push(node);
    // Same-file bare method name — unambiguous here, resolved by the standard
    // name matcher (no sentinel needed), exactly like Spring's route refs.
    references.push({
      fromNodeId: node.id,
      referenceName: methodMatch[1]!,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'java',
    });
  }

  return { nodes, references };
}
