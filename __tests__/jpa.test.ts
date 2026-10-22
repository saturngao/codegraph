import { describe, it, expect } from 'vitest';
import { jpaResolver } from '../src/resolution/frameworks/jpa';
import type { ResolutionContext } from '../src/resolution/types';

const ORDER_ENTITY = `package com.example.domain;

import javax.persistence.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.HashSet;

@Entity
@Table(name = "orders")
public class Order {
  @Id
  private Long id;

  // OneToMany items: List<OrderItem> -> target=OrderItem mappedBy=order
  @OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
  @JoinColumn(name = "order_id")
  private List<OrderItem> items = new ArrayList<>();

  @ManyToOne
  private Customer customer;

  @ManyToMany
  private Set<Tag> tags = new HashSet<>();
}
`;

const ORDER_REPOSITORY = `package com.example.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import com.example.domain.Order;
import com.example.domain.Customer;
import java.util.List;

public interface OrderRepository extends JpaRepository<Order, Long> {

  List<Order> findByCustomerId(Long customerId);

  @Query("select o from Order o join o.items i where i.sku = :sku")
  List<Order> findWithTagged(String sku);

  @Query(value = "select c from Customer c where c.tier = 'gold'")
  List<Customer> findGoldCustomers();
}
`;

describe('jpaResolver.extract — @Entity connector nodes', () => {
  const { nodes, references } = jpaResolver.extract!('src/com/example/domain/Order.java', ORDER_ENTITY);
  const entity = nodes.find((n) => n.name === 'Order')!;

  it('emits one jpa:entity connector node for the @Entity class', () => {
    expect(entity).toBeDefined();
    expect(entity.kind).toBe('constant');
    expect(entity.qualifiedName).toBe('src/com/example/domain/Order.java::jpa:entity:Order');
    expect(entity.language).toBe('java');
    expect(entity.signature).toBe('@Entity @Table(name="orders")');
  });

  it('lists the relations in the docstring with targets and mappedBy', () => {
    expect(entity.docstring).toContain('OneToMany items → OrderItem (mappedBy=order)');
    expect(entity.docstring).toContain('ManyToOne customer → Customer');
    expect(entity.docstring).toContain('ManyToMany tags → Tag');
  });

  it('emits one bare-name reference per relation target', () => {
    const targets = references.map((r) => r.referenceName).sort();
    expect(targets).toEqual(['Customer', 'OrderItem', 'Tag']);
    expect(references.every((r) => r.fromNodeId === entity.id)).toBe(true);
    expect(references.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('extracts relations annotated with initializers and interleaved annotations', () => {
    // items (List with `= new ArrayList<>()` + interleaved @JoinColumn) is in the docstring —
    // the sandbox-validated regression cases.
    expect(entity.docstring).toContain('items');
    expect(entity.docstring).toContain('tags');
  });
});

describe('jpaResolver.extract — Spring Data repositories', () => {
  const { nodes, references } = jpaResolver.extract!('src/com/example/repo/OrderRepository.java', ORDER_REPOSITORY);
  const repo = nodes.find((n) => n.name === 'OrderRepository')!;

  it('emits one jpa:repository connector node with the managed entity', () => {
    expect(repo).toBeDefined();
    expect(repo.kind).toBe('constant');
    expect(repo.qualifiedName).toBe('src/com/example/repo/OrderRepository.java::jpa:repository:OrderRepository');
    expect(repo.signature).toBe('repository for Order');
    expect(repo.docstring).toContain('managing entity Order');
  });

  it('references the managed entity plus every @Query JPQL entity', () => {
    const targets = references.filter((r) => r.fromNodeId === repo.id).map((r) => r.referenceName);
    expect(targets).toContain('Order');
    expect(targets).toContain('Customer');
  });

  it('does not mistake JPQL aliases for entities (case-sensitive from/join)', () => {
    const targets = references.filter((r) => r.fromNodeId === repo.id).map((r) => r.referenceName);
    expect(targets).not.toContain('o');
    expect(targets).not.toContain('i');
    expect(targets).not.toContain('c');
  });
});

describe('jpaResolver.extract — boundaries', () => {
  it('returns empty for a non-Java file', () => {
    expect(jpaResolver.extract!('pom.xml', '<project/>')).toEqual({ nodes: [], references: [] });
  });

  it('returns empty for Java without JPA markers', () => {
    expect(jpaResolver.extract!('src/Main.java', 'public class Main { void m() {} }')).toEqual({
      nodes: [],
      references: [],
    });
  });

  it('ignores commented-out entities', () => {
    const src = `public class Foo {
  // @Entity
  // public class Ghost extends Object {}
}
`;
    const { nodes } = jpaResolver.extract!('src/Foo.java', src);
    expect(nodes).toEqual([]);
  });
});

describe('jpaResolver.extract — multiple interfaces in one file', () => {
  it('attributes each @Query to its own interface', () => {
    const src = `package com.example.repo;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

interface OrderRepository extends JpaRepository<Order, Long> {
  @Query("select o from Order o where o.flag = true")
  List<Order> findFlagged();
}

interface CustomerRepository extends JpaRepository<Customer, Long> {
  @Query("select c from Customer c where c.vip = true")
  List<Customer> findVip();
}
`;
    const { nodes, references } = jpaResolver.extract!('src/Repos.java', src);
    const orderRepo = nodes.find((n) => n.name === 'OrderRepository')!;
    const customerRepo = nodes.find((n) => n.name === 'CustomerRepository')!;
    expect(orderRepo).toBeDefined();
    expect(customerRepo).toBeDefined();
    const orderRefs = references.filter((r) => r.fromNodeId === orderRepo.id).map((r) => r.referenceName);
    const customerRefs = references
      .filter((r) => r.fromNodeId === customerRepo.id)
      .map((r) => r.referenceName);
    expect(orderRefs).toEqual(['Order']);
    expect(customerRefs).toEqual(['Customer']);
  });
});

describe('jpaResolver.detect', () => {
  const ctx = (files: Record<string, string | null>, allFiles: string[]): ResolutionContext =>
    ({
      readFile: (p: string) => files[p] ?? null,
      getAllFiles: () => allFiles,
    }) as unknown as ResolutionContext;

  it('detects via pom.xml persistence markers', () => {
    expect(
      jpaResolver.detect(
        ctx({ 'pom.xml': '<artifactId>spring-boot-starter-data-jpa</artifactId>' }, [])
      )
    ).toBe(true);
    expect(jpaResolver.detect(ctx({ 'pom.xml': '<artifactId>jakarta.persistence-api</artifactId>' }, []))).toBe(true);
  });

  it('falls back to an @Entity scan for build-file-less legacy projects', () => {
    expect(jpaResolver.detect(ctx({}, ['src/A.java', 'src/B.java']))).toBe(false);
    expect(jpaResolver.detect(ctx({ 'src/A.java': 'public class A {}' }, ['src/A.java']))).toBe(false);
    expect(jpaResolver.detect(ctx({ 'src/A.java': '@Entity public class A {}' }, ['src/A.java']))).toBe(true);
  });
});

describe('jpaResolver.resolve', () => {
  it('returns null — bare entity names ride the standard name matcher', () => {
    const ref = {
      fromNodeId: 'jpa-entity:x:1:Order',
      referenceName: 'Customer',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'src/Order.java',
      language: 'java' as const,
    };
    expect(jpaResolver.resolve(ref, {} as ResolutionContext)).toBeNull();
  });
});
