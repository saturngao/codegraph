import { describe, it, expect } from 'vitest';
import { strutsResolver } from '../src/resolution/frameworks/struts';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

const STRUTS2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE struts PUBLIC "-//Apache Software Foundation//DTD Struts Configuration 2.5//EN"
  "http://struts.apache.org/dtds/struts-2.5.dtd">
<struts>
  <package name="default" namespace="/" extends="struts-default">
    <action name="welcome" class="com.example.WelcomeAction">
      <result name="success">/pages/welcome.jsp</result>
    </action>
    <action name="login" class="com.example.LoginAction" method="doLogin">
      <result name="success" type="redirect">/pages/home.jsp</result>
      <result name="input">/pages/login.jsp</result>
    </action>
    <!-- commented out: <action name="ghost" class="com.example.GhostAction"/> -->
    <action name="user/*" class="com.example.UserAction" method="{1}">
      <result>/pages/user.jsp</result>
    </action>
    <action name="logout">
      <result>/pages/goodbye.jsp</result>
    </action>
  </package>
  <package name="admin" namespace="/admin">
    <action name="dashboard" class="com.example.admin.DashboardAction" method="show">
      <result name="success">
        <param name="location">/pages/admin/dashboard.jsp</param>
      </result>
    </action>
  </package>
</struts>
`;

const STRUTS1_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE struts-config PUBLIC "-//Apache Software Foundation//DTD Struts Configuration 1.3//EN"
  "http://jakarta.apache.org/struts/dtds/struts-config_1_3.dtd">
<struts-config>
  <form-beans>
    <form-bean name="loginForm" type="com.example.forms.LoginForm"/>
  </form-beans>
  <action-mappings>
    <action path="/login" type="com.example.LoginAction" name="loginForm" scope="request">
      <forward name="success" path="/pages/main.jsp"/>
      <forward name="failure" path="/pages/login.jsp"/>
    </action>
    <action path="/orders/*" type="com.example.OrderAction" parameter="method">
      <forward name="list" path="/pages/orders.jsp"/>
    </action>
  </action-mappings>
</struts-config>
`;

function xmlContext(files: Record<string, Node[]>): ResolutionContext {
  return {
    getNodesByName: (name: string) => files[name] ?? [],
    getNodesByKind: () => [],
    getAllFiles: () => [],
    readFile: () => null,
    getNodesInFile: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByLowerName: () => [],
    fileExists: () => true,
    getImportMappings: () => [],
    getProjectRoot: () => '/proj',
  } as unknown as ResolutionContext;
}

function javaMethod(id: string, name: string, filePath: string): Node {
  return {
    id,
    kind: 'method',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'java',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

describe('strutsResolver.extract — Struts2 struts.xml', () => {
  const { nodes, references } = strutsResolver.extract!('resources/struts.xml', STRUTS2_XML);
  const routes = nodes.filter((n) => n.kind === 'route');

  it('emits one route per action with namespace joined', () => {
    const paths = routes.map((n) => n.name).sort();
    expect(paths).toEqual([
      'ACTION /admin/dashboard',
      'ACTION /login',
      'ACTION /logout',
      'ACTION /user/*',
      'ACTION /welcome',
    ]);
  });

  it('emits a handler ref keyed FQN::method:struts for class actions', () => {
    const refs = references.map((r) => r.referenceName);
    expect(refs).toContain('com.example.WelcomeAction::execute:struts');
    expect(refs).toContain('com.example.LoginAction::doLogin:struts');
    expect(refs).toContain('com.example.admin.DashboardAction::show:struts');
  });

  it('skips the handler ref for DMI wildcard methods and class-less actions', () => {
    const refs = references.map((r) => r.referenceName);
    expect(refs).not.toContain('com.example.UserAction::{1}:struts');
    const userRoute = routes.find((n) => n.name === 'ACTION /user/*')!;
    expect(userRoute.docstring).toContain('wildcard/DMI');
    const logoutRoute = routes.find((n) => n.name === 'ACTION /logout')!;
    expect(logoutRoute.docstring).toContain('no class attribute');
  });

  it('ignores commented-out actions', () => {
    expect(routes.map((n) => n.name)).not.toContain('ACTION /ghost');
  });

  it('records results (incl. <param name="location">) in the docstring', () => {
    const login = routes.find((n) => n.name === 'ACTION /login')!;
    expect(login.docstring).toContain('success → /pages/home.jsp (redirect)');
    expect(login.docstring).toContain('input → /pages/login.jsp');
    const dashboard = routes.find((n) => n.name === 'ACTION /admin/dashboard')!;
    expect(dashboard.docstring).toContain('/pages/admin/dashboard.jsp');
  });

  it('sets the handler signature on the route node', () => {
    const login = routes.find((n) => n.name === 'ACTION /login')!;
    expect(login.signature).toBe('com.example.LoginAction#doLogin');
  });

  it('routes carry line numbers into the file (positions preserved through comment stripping)', () => {
    const welcome = routes.find((n) => n.name === 'ACTION /welcome')!;
    expect(welcome.startLine).toBeGreaterThan(5);
    expect(welcome.filePath).toBe('resources/struts.xml');
    expect(welcome.language).toBe('xml');
  });
});

describe('strutsResolver.extract — Struts1 struts-config.xml', () => {
  const { nodes, references } = strutsResolver.extract!('WEB-INF/struts-config.xml', STRUTS1_XML);
  const routes = nodes.filter((n) => n.kind === 'route');

  it('emits one route per action-mappings action with forwards as results', () => {
    const login = routes.find((n) => n.name === 'ACTION /login')!;
    expect(login).toBeDefined();
    expect(login!.docstring).toContain('success → /pages/main.jsp');
    expect(login!.docstring).toContain('form-bean: loginForm');
  });

  it('emits a handler ref keyed type::execute:struts', () => {
    expect(references.map((r) => r.referenceName)).toContain('com.example.LoginAction::execute:struts');
  });

  it('skips the handler ref for DispatchAction (parameter attr) and notes it', () => {
    const refs = references.map((r) => r.referenceName);
    expect(refs).not.toContain('com.example.OrderAction::execute:struts');
    const orders = routes.find((n) => n.name === 'ACTION /orders/*')!;
    expect(orders.docstring).toContain('DispatchAction');
    expect(orders.docstring).toContain('not statically resolvable');
  });
});

describe('strutsResolver.extract — non-struts XML', () => {
  it('returns empty for a pom.xml', () => {
    const { nodes, references } = strutsResolver.extract!(
      'pom.xml',
      '<project><dependencies><dependency>struts2-core</dependency></dependencies></project>'
    );
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });

  it('returns empty for an unrelated xml', () => {
    const { nodes } = strutsResolver.extract!('src/main/resources/log4j.xml', '<log4j:configuration/>');
    expect(nodes).toEqual([]);
  });

  it('picks up include-split module configs by basename (struts-user.xml)', () => {
    const { nodes } = strutsResolver.extract!(
      'resources/struts-user.xml',
      '<struts><package name="u" namespace="/user"><action name="view" class="com.example.UserAction" method="view"/></package></struts>'
    );
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(1);
  });
});

describe('strutsResolver.extract — struts2-convention-plugin @Action', () => {
  const src = `package com.example.web;

import org.apache.struts2.convention.annotation.Action;
import org.apache.struts2.convention.annotation.Namespace;
import org.apache.struts2.convention.annotation.Result;

@Namespace("/orders")
public class OrderAction extends ActionSupport {
  // @Action("/skipped") — must not match inside a comment
  @Action(value = "view")
  public String view() { return SUCCESS; }

  @Action("/direct")
  public String direct() { return SUCCESS; }
}
`;
  const { nodes, references } = strutsResolver.extract!('src/java/com/example/web/OrderAction.java', src);

  it('emits a route per @Action with the @Namespace prefix', () => {
    expect(nodes.map((n) => n.name).sort()).toEqual(['ACTION /orders/direct', 'ACTION /orders/view']);
    expect(nodes.every((n) => n.language === 'java')).toBe(true);
  });

  it('references the decorated method by bare same-file name', () => {
    expect(references).toHaveLength(2);
    expect(references[0]!.referenceName).toBe('view');
    expect(references[0]!.language).toBe('java');
    expect(references[1]!.referenceName).toBe('direct');
  });

  it('does not match @Action inside comments', () => {
    expect(nodes.map((n) => n.name)).not.toContain('ACTION /orders/skipped');
  });
});

describe('strutsResolver.resolve', () => {
  const ref = (referenceName: string): UnresolvedRef => ({
    fromNodeId: 'route:x',
    referenceName,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'struts.xml',
    language: 'xml',
  });

  it('resolves FQN::method:struts to the Java method in the class-named file', () => {
    const login = javaMethod('m1', 'doLogin', 'src/com/example/LoginAction.java');
    const context = xmlContext({ doLogin: [login] });
    const result = strutsResolver.resolve(ref('com.example.LoginAction::doLogin:struts'), context);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('m1');
    expect(result!.resolvedBy).toBe('framework');
  });

  it('disambiguates same-named classes by the FQN package path', () => {
    const admin = javaMethod('m-admin', 'execute', 'src/com/example/admin/DeleteAction.java');
    const shop = javaMethod('m-shop', 'execute', 'src/com/example/shop/DeleteAction.java');
    const context = xmlContext({ execute: [shop, admin] });
    const result = strutsResolver.resolve(ref('com.example.admin.DeleteAction::execute:struts'), context);
    expect(result!.targetNodeId).toBe('m-admin');
  });

  it('returns null on remaining ambiguity and on a bean-name class (no matching file)', () => {
    const a = javaMethod('m1', 'doLogin', 'a/LoginAction.java');
    const b = javaMethod('m2', 'doLogin', 'b/LoginAction.java');
    expect(strutsResolver.resolve(ref('com.example.LoginAction::doLogin:struts'), xmlContext({ doLogin: [a, b] }))).toBeNull();
    expect(strutsResolver.resolve(ref('loginActionBean::doLogin:struts'), xmlContext({ doLogin: [a] }))).toBeNull();
  });

  it('leaves non-struts refs alone', () => {
    expect(strutsResolver.resolve(ref('com.example.LoginAction::doLogin'), xmlContext({}))).toBeNull();
  });
});

describe('strutsResolver.detect', () => {
  it('detects via pom.xml struts dependency', () => {
    const context = {
      readFile: (p: string) => (p === 'pom.xml' ? '<artifactId>struts2-core</artifactId>' : null),
      getAllFiles: () => [],
    } as unknown as ResolutionContext;
    expect(strutsResolver.detect(context)).toBe(true);
  });

  it('detects via a struts-config.xml in the file list', () => {
    const context = {
      readFile: () => null,
      getAllFiles: () => ['webapp/WEB-INF/struts-config.xml'],
    } as unknown as ResolutionContext;
    expect(strutsResolver.detect(context)).toBe(true);
  });

  it('is false for a plain project', () => {
    const context = {
      readFile: () => null,
      getAllFiles: () => ['src/Main.java'],
    } as unknown as ResolutionContext;
    expect(strutsResolver.detect(context)).toBe(false);
  });
});
