/**
 * JPA Framework Resolver (javax/jakarta persistence + Spring Data JPA)
 *
 * Emits connector nodes carrying JPA semantics the tree-sitter pass can't
 * see: entity classes are indexed as plain classes, so their relationship
 * map — the thing a module split needs to draw data boundaries — exists only
 * as annotations scattered across fields. One `constant` node per @Entity
 * class (`jpa:entity:<Class>`) lists its @OneToMany/@ManyToOne/@ManyToMany/
 * @OneToOne relations in the docstring with a `references` ref to each
 * related entity; one per Spring Data repository interface
 * (`jpa:repository:<I>`) references the managed entity plus every entity a
 * `@Query` JPQL string names. Exploring an entity then shows these connector
 * nodes among its incoming references — the relation list at a glance.
 *
 * The refs are BARE class names (`Order`), not a sentinel: the entity class
 * is a real symbol, so the standard name matcher resolves them — its
 * same-file preference, import awareness and visibility rules all apply, and
 * a name that matches nothing stays unresolved (an out-of-project entity,
 * the honest outcome). `resolve()` therefore has nothing to add.
 *
 * Statically out of reach, left alone rather than guessed: JPQL string
 * concatenation across `+`, named queries in orm.xml, and the runtime
 * semantics (lazy loading, cache) no static pass can see.
 */
import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const REPOSITORY_ANCESTORS =
  'JpaRepository|CrudRepository|PagingAndSortingRepository|JpaSpecificationExecutor|Repository';
const RELATION_ANNOTATIONS = 'OneToMany|ManyToOne|ManyToMany|OneToOne';

/** JDK value types a relation field's generic may name — never entities, so a
 * `Map<String, Customer>` picks Customer, not String. */
const JDK_VALUE_TYPES = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short',
  'BigDecimal', 'BigInteger', 'Date', 'LocalDate', 'LocalDateTime', 'Object',
]);

export const jpaResolver: FrameworkResolver = {
  name: 'jpa',
  languages: ['java'],

  detect(context: ResolutionContext): boolean {
    for (const buildFile of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      const content = context.readFile(buildFile);
      if (
        content &&
        /(javax\.persistence|jakarta\.persistence|spring-boot-starter-data-jpa|hibernate-core|eclipselink)/.test(
          content
        )
      ) {
        return true;
      }
    }
    // Legacy projects may predate the build-file markers (Ant + hand-managed
    // jars) — annotation presence wins. Same whole-project scan spring
    // resolver's detect pays when its build files don't mention Spring.
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.java')) continue;
      const content = context.readFile(file);
      if (content && content.includes('@Entity')) return true;
    }
    return false;
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    // The refs extract() emits are bare entity class names — real symbols
    // the standard name matcher resolves with import/visibility awareness.
    return null;
  },

  extract(filePath: string, content: string) {
    if (!filePath.endsWith('.java')) return { nodes: [] as Node[], references: [] as UnresolvedRef[] };
    if (!content.includes('@Entity') && !/Repository\s*</.test(content)) {
      return { nodes: [] as Node[], references: [] as UnresolvedRef[] };
    }

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'java');
    const line = (idx: number) => safe.slice(0, idx).split('\n').length;

    // ---- relation fields, file-scoped ----
    // Relations may be interleaved with other annotations (@JoinColumn,
    // @JoinTable, …) and carry initializers — both allowed for below. Each
    // star iteration consumes `\s*@Annotation(...)` and must eat at least the
    // `@`, so `\s*` (not `\s`) is what lets the next annotation sit on its
    // own indented line — `\s` alone fails on `\n  @JoinColumn`.
    const relRe = new RegExp(
      `@(${RELATION_ANNOTATIONS})\\s*(?:\\(([^)]*)\\))?` +
        `(?:\\s*@[\\w.]+(?:\\([^)]*\\))?)*` +
        `\\s*(?:private|protected|public)?\\s*(?:final\\s+)?` +
        `([\\w.<>\\[\\], ]+?)\\s+(\\w+)\\s*(?:=[^;]*)?;`,
      'g'
    );
    const relations: Array<{ anno: string; field: string; target: string; mappedBy?: string }> = [];
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(safe)) !== null) {
      // Target entity: the first capitalized type inside the generic
      // (`List<OrderItem>` → OrderItem), skipping JDK value types — a
      // `Map<String, Customer>` relation points at Customer, not String.
      const strippedType = rm[3]!.replace(/(?:List|Set|Collection|Map)\s*<|>|,/g, ' ');
      const target = strippedType.match(/[A-Z]\w*/g)?.find((t) => !JDK_VALUE_TYPES.has(t));
      if (!target) continue;
      const mappedBy = /mappedBy\s*=\s*"([^"]*)"/.exec(rm[2] ?? '')?.[1];
      relations.push({ anno: rm[1]!, field: rm[4]!, target, mappedBy });
    }

    // ---- @Entity classes ----
    // One public class per file in Java — file-scoped relations are exact
    // for the common layout; a same-file package-private second entity is
    // rare and only misattributes relations between two of its own classes.
    // The annotation stack between @Entity and `class` is captured so @Table
    // is found whether it precedes or follows @Entity.
    const entityRe =
      /@Entity\s*(?:\([^)]*\))?\s*((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:public\s+|final\s+|abstract\s+)?class\s+(\w+)/g;
    let em: RegExpExecArray | null;
    while ((em = entityRe.exec(safe)) !== null) {
      const cls = em[2]!;
      // @Table sits in the annotation stack around @Entity.
      const table = /@Table\s*\([^)]*name\s*=\s*"([^"]*)"/
        .exec(
          (em[1] ?? '') + '\n' + safe.slice(Math.max(0, em.index - 400), em.index)
        )?.[1];
      const relDoc = relations
        .map((r) => `${r.anno} ${r.field} → ${r.target}${r.mappedBy ? ` (mappedBy=${r.mappedBy})` : ''}`)
        .join('; ');
      nodes.push({
        id: `jpa-entity:${filePath}:${line(em.index)}:${cls}`,
        kind: 'constant',
        name: cls,
        qualifiedName: `${filePath}::jpa:entity:${cls}`,
        filePath,
        startLine: line(em.index),
        endLine: line(em.index),
        startColumn: 0,
        endColumn: 0,
        language: 'java',
        signature: `@Entity${table ? ` @Table(name="${table}")` : ''}`,
        docstring: `JPA entity${table ? ` (table: ${table})` : ''}${
          relDoc ? ` | relations: ${relDoc}` : ''
        }`
          .slice(0, 400),
        updatedAt: now,
      });
      for (const r of relations) {
        references.push({
          fromNodeId: `jpa-entity:${filePath}:${line(em.index)}:${cls}`,
          referenceName: r.target,
          referenceKind: 'references',
          line: line(em.index),
          column: 0,
          filePath,
          language: 'java',
        });
      }
    }

    // ---- Spring Data repositories ----
    const repoRe = new RegExp(
      `interface\\s+(\\w+)\\s+extends\\s+[^{]*\\b(?:${REPOSITORY_ANCESTORS})\\s*<\\s*([\\w.]+)\\s*,`,
      'g'
    );
    while ((rm = repoRe.exec(safe)) !== null) {
      const repoName = rm[1]!;
      const entity = rm[2]!.split('.').pop()!;
      const nodeId = `jpa-repository:${filePath}:${line(rm.index)}:${repoName}`;
      nodes.push({
        id: nodeId,
        kind: 'constant',
        name: repoName,
        qualifiedName: `${filePath}::jpa:repository:${repoName}`,
        filePath,
        startLine: line(rm.index),
        endLine: line(rm.index),
        startColumn: 0,
        endColumn: 0,
        language: 'java',
        signature: `repository for ${entity}`,
        docstring: `Spring Data JPA repository managing entity ${entity}`,
        updatedAt: now,
      });
      references.push({
        fromNodeId: nodeId,
        referenceName: entity,
        referenceKind: 'references',
        line: line(rm.index),
        column: 0,
        filePath,
        language: 'java',
      });

      // @Query JPQL entities, scoped to THIS interface's body (a file may
      // hold several package-private interfaces). Case-sensitive on purpose:
      // JPQL aliases are lowercase, entity names capitalized — an `i` flag
      // matched the alias (`from Order o join o.items` → `o`).
      const nextInterface = /\n\s*(?:public\s+)?interface\s/.exec(safe.slice(rm.index + 10));
      const bodyEnd = nextInterface ? rm.index + 10 + nextInterface.index : safe.length;
      const body = safe.slice(rm.index, bodyEnd);
      let qm: RegExpExecArray | null;
      const queryRe = /@Query\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/g;
      while ((qm = queryRe.exec(body)) !== null) {
        const lineNo = line(rm.index + qm.index);
        for (const ent of qm[1]!.match(/\b(?:from|join(?:\s+fetch)?)\s+([A-Z]\w*)/g) ?? []) {
          const name = ent.replace(/^.*?\s+/, '');
          if (name !== entity) {
            references.push({
              fromNodeId: nodeId,
              referenceName: name,
              referenceKind: 'references',
              line: lineNo,
              column: 0,
              filePath,
              language: 'java',
            });
          }
        }
      }
    }

    return { nodes, references };
  },
};
