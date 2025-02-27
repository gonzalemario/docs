// this patch is required to consistently load all the doc files
const realFs = require("fs");
const path = require("path");
const gracefulFs = require("graceful-fs");
gracefulFs.gracefulify(realFs);

const { createFilePath } = require(`gatsby-source-filesystem`);
const { exec, execSync } = require("child_process");

const {
  replacePathVersion,
  filePathToDocType,
  removeTrailingSlash,
  isPathAnIndexPage,
  pathToDepth,
  mdxNodesToTree,
  computeFrontmatterForTreeNode,
  buildProductVersions,
  reportMissingIndex,
  treeToNavigation,
  treeNodeToNavNode,
  findPrevNextNavNodes,
  configureRedirects,
  configureLegacyRedirects,
  readFile,
  writeFile,
} = require("./src/constants/gatsby-utils.js");

const gitData = (() => {
  // if this build was triggered by a GH action in response to a PR,
  // use the head ref (the branch that someone is requesting be merged)
  let branch = process.env.GITHUB_HEAD_REF;
  // if this process was otherwise triggered by a GH action, use the current branch name
  if (!branch) branch = process.env.GITHUB_REF;
  // assuming this is triggered by a GH action, this will be the commit that triggered the workflow
  let sha = process.env.GITHUB_SHA;
  // non-GH Action build? Try actually running Git for the name & sha...
  if (!branch) {
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD").toString();
      sha = execSync("git rev-parse HEAD").toString();
    } catch {}
  }
  if (!branch)
    branch = process.env.APP_ENV === "production" ? "main" : "develop";
  if (!sha) sha = "";

  branch = branch
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
  sha = sha.trim();

  return { branch, sha };
})();

exports.onCreateNode = async ({ node, getNode, actions, loadNodeContent }) => {
  const { createNodeField } = actions;

  if (node.internal.mediaType === "text/yaml") {
    // See: https://github.com/gatsbyjs/gatsby/issues/34605
    const content = await loadNodeContent(node);
    createNodeField({ node, name: "content", value: content });
  }
  if (node.internal.type !== "Mdx") return;

  const fileNode = getNode(node.parent);
  const nodeFields = {
    docType: filePathToDocType(node.fileAbsolutePath),
    mtime: fileNode.mtime,
  };

  let relativeFilePath = createFilePath({ node, getNode });
  if (nodeFields.docType === "doc") {
    relativeFilePath = `/${fileNode.sourceInstanceName}${relativeFilePath}`;
  }

  Object.assign(nodeFields, {
    path: relativeFilePath,
    depth: pathToDepth(relativeFilePath),
  });

  if (nodeFields.docType === "doc") {
    Object.assign(nodeFields, {
      product: relativeFilePath.split("/")[1],
      version: relativeFilePath.split("/")[2],
      topic: "null",
    });
  } else if (nodeFields.docType === "advocacy") {
    Object.assign(nodeFields, {
      product: "null",
      version: "0",
      topic: relativeFilePath.split("/")[2],
    });
  }

  for (const [name, value] of Object.entries(nodeFields)) {
    createNodeField({ node, name: name, value: value });
  }
};

exports.createPages = async ({ actions, graphql, reporter }) => {
  const result = await graphql(`
    query {
      allMdx {
        nodes {
          id
          frontmatter {
            title
            navTitle
            description
            redirects
            iconName
            originalFilePath
            productStub
            indexCards
            originalFilePath
            editTarget
            navigation
            legacyRedirects
            legacyRedirectsGenerated
            navigation
            showInteractiveBadge
            hideToC
            katacodaPages {
              scenario
              account
            }
            katacodaPanel {
              scenario
              account
              initializeCommand
              codelanguages
            }
            hideVersion
            displayBanner
            directoryDefaults {
              description
              prevNext
              iconName
              editTarget
              product
              platform
              indexCards
              showInteractiveBadge
              hideVersion
              displayBanner
            }
          }
          fields {
            docType
            path
            depth
            product
            version
            topic
          }
          fileAbsolutePath
        }
      }
      allFile(filter: { extension: { eq: "yaml" } }) {
        nodes {
          id
          relativePath
          sourceInstanceName
        }
      }
    }
  `);

  if (result.errors) {
    reporter.panic("createPages graphql query has errors!", result.errors);
  }

  // this is critical to avoiding excessive Netlify deploy times: it ensures the pages are ordered consistently from build to build
  result.data.allMdx.nodes = result.data.allMdx.nodes.sort((a, b) =>
    a.fields.path.localeCompare(b.fields.path),
  );

  const { nodes } = result.data.allMdx;
  const productVersions = buildProductVersions(nodes);

  processFileNodes(result.data.allFile.nodes, productVersions, actions);

  // it should be possible to remove these in the future,
  // they are only used for navLinks generation
  const learn = nodes.filter((file) => file.fields.docType === "advocacy");

  // perform depth first preorder traversal
  const treeRoot = mdxNodesToTree(nodes);
  const navStack = [treeRoot];
  let curr = null;

  while (navStack.length > 0) {
    curr = navStack.pop();
    curr.children.forEach((child) => navStack.push(child));

    // build ordered navigation for immediate children
    // treeToNavigation will use this data
    const addedChildPaths = {};
    curr.navigationNodes = [];
    (curr.mdxNode?.frontmatter?.navigation || []).forEach((navEntry) => {
      if (navEntry.startsWith("#")) {
        curr.navigationNodes.push({
          path: null,
          title: navEntry.replace("#", "").trim(),
        });
        return;
      }

      const navChild = curr.children.find((child) => {
        if (addedChildPaths[child.path]) return false;
        const navName = child.path.split("/").slice(-2)[0];
        return navName.toLowerCase() === navEntry.toLowerCase();
      });
      if (!navChild?.mdxNode) return;

      addedChildPaths[navChild.path] = true;
      curr.navigationNodes.push(treeNodeToNavNode(navChild));
    });

    curr.children
      .filter((child) => !addedChildPaths[child.path])
      .map((child) => treeNodeToNavNode(child))
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach((child) => curr.navigationNodes.push(child));

    // exit here if we're not dealing with an actual page
    if (!curr.mdxNode) {
      reportMissingIndex(reporter, curr);
      continue;
    }

    const node = curr.mdxNode;

    // set computed frontmatter
    node.frontmatter = computeFrontmatterForTreeNode(curr);

    // build navigation tree
    const navigationDepth = 1;
    let navRoot = curr;
    while (navRoot.depth > navigationDepth && navRoot?.parent?.mdxNode)
      navRoot = navRoot.parent;
    const navTree = treeToNavigation(navRoot, node);

    // determine next and previous nodes
    const prevNext = findPrevNextNavNodes(navTree, curr);

    const { docType } = node.fields;

    const isLatest =
      docType === "doc"
        ? productVersions[node.fields.product][0] === node.fields.version
        : false;
    configureRedirects(
      node.fields.path,
      isLatest,
      node.frontmatter.redirects,
      actions,
    );

    if (docType === "doc") {
      createDoc(navTree, prevNext, node, productVersions, actions);
    } else if (docType === "advocacy") {
      createAdvocacy(navTree, prevNext, node, learn, actions);
    }
  }
};

const createDoc = (navTree, prevNext, doc, productVersions, actions) => {
  const isLatest =
    productVersions[doc.fields.product][0] === doc.fields.version;
  if (isLatest) {
    actions.createRedirect({
      fromPath: doc.fields.path,
      toPath: replacePathVersion(doc.fields.path),
      redirectInBrowser: true,
      isPermanent: false,
      force: true,
    });
  }

  // configure legacy redirects
  if (!doc.frontmatter.productStub) {
    configureLegacyRedirects({
      toPath: doc.fields.path,
      toLatestPath: replacePathVersion(doc.fields.path),
      redirects: (doc.frontmatter.legacyRedirects || []).concat(
        doc.frontmatter.legacyRedirectsGenerated || [],
      ),
      actions,
    });
  }

  const isIndexPage = isPathAnIndexPage(doc.fileAbsolutePath);
  const docsRepoUrl = "https://github.com/EnterpriseDB/docs";
  // don't encourage folks to edit on main - set the edit links to develop in production builds
  const branch = gitData.branch === "main" ? "develop" : gitData.branch;
  const fileUrlSegment =
    removeTrailingSlash(doc.fields.path) +
    (isIndexPage ? "/index.mdx" : ".mdx");
  const githubFileLink = `${docsRepoUrl}/commits/${branch}/product_docs/docs${fileUrlSegment}`;
  const githubEditLink = `${docsRepoUrl}/edit/${branch}/product_docs/docs${fileUrlSegment}`;
  const githubIssuesLink = `${docsRepoUrl}/issues/new?title=Feedback%20on%20${encodeURIComponent(
    fileUrlSegment,
  )}`;

  const template = doc.frontmatter.productStub ? "doc-stub.js" : "doc.js";
  const path = isLatest ? replacePathVersion(doc.fields.path) : doc.fields.path;

  actions.createPage({
    path: path,
    component: require.resolve(`./src/templates/${template}`),
    context: {
      frontmatter: doc.frontmatter,
      pagePath: path,
      navTree,
      prevNext,
      versions: productVersions[doc.fields.product],
      nodeId: doc.id,
      githubFileLink: githubFileLink,
      githubEditLink: githubEditLink,
      githubIssuesLink: githubIssuesLink,
      isIndexPage: isIndexPage,
      potentialLatestPath: replacePathVersion(doc.fields.path), // the latest url for this path (may not exist!)
      potentialLatestNodePath: replacePathVersion(
        doc.fields.path,
        productVersions[doc.fields.product][0],
      ), // the latest version number path (may not exist!), needed for query
    },
  });

  (doc.frontmatter.katacodaPages || []).forEach((katacodaPage) => {
    if (!katacodaPage.scenario || !katacodaPage.account) {
      throw new Error(
        `katacoda scenario or account missing for ${doc.fields.path}`,
      );
    }

    const path = `${doc.fields.path}${katacodaPage.scenario}`;
    actions.createPage({
      path: path,
      component: require.resolve("./src/templates/katacoda-page.js"),
      context: {
        ...katacodaPage,
        pagePath: path,
        learn: {
          title: doc.frontmatter.title,
          description: doc.frontmatter.description,
        },
      },
    });
  });
};

const createAdvocacy = (navTree, prevNext, doc, learn, actions) => {
  // configure legacy redirects
  configureLegacyRedirects({
    toPath: doc.fields.path,
    toLatestPath: doc.fields.path,
    redirects: (doc.frontmatter.legacyRedirects || []).concat(
      doc.frontmatter.legacyRedirectsGenerated || [],
    ),
    actions,
  });

  const navLinks = learn.filter(
    (node) => node.fields.topic === doc.fields.topic,
  );

  const advocacyDocsRepoUrl = "https://github.com/EnterpriseDB/docs";
  // don't encourage folks to edit on main - set the edit links to develop in production builds
  const branch = gitData.branch === "main" ? "develop" : gitData.branch;
  const isIndexPage = isPathAnIndexPage(doc.fileAbsolutePath);
  const fileUrlSegment =
    removeTrailingSlash(doc.fields.path) +
    (isIndexPage ? "/index.mdx" : ".mdx");
  const githubFileLink = `${advocacyDocsRepoUrl}/commits/${branch}/advocacy_docs${fileUrlSegment}`;
  const githubEditLink = `${advocacyDocsRepoUrl}/edit/${branch}/advocacy_docs${fileUrlSegment}`;
  const githubIssuesLink = `${advocacyDocsRepoUrl}/issues/new?title=Regarding%20${encodeURIComponent(
    fileUrlSegment,
  )}`;

  // workaround for https://github.com/gatsbyjs/gatsby/issues/26520
  actions.createPage({
    path: doc.fields.path,
    component: require.resolve("./src/templates/learn-doc.js"),
    context: {},
  });

  actions.createPage({
    path: doc.fields.path,
    component: require.resolve("./src/templates/learn-doc.js"),
    context: {
      nodeId: doc.id,
      frontmatter: doc.frontmatter,
      pagePath: doc.fields.path,
      navLinks: navLinks,
      prevNext,
      navTree,
      githubFileLink: githubFileLink,
      githubEditLink: githubEditLink,
      githubIssuesLink: githubIssuesLink,
      isIndexPage: isIndexPage,
    },
  });

  (doc.frontmatter.katacodaPages || []).forEach((katacodaPage) => {
    if (!katacodaPage.scenario || !katacodaPage.account) {
      throw new Error(
        `katacoda scenario or account missing for ${doc.fields.path}`,
      );
    }

    const path = `${doc.fields.path}${katacodaPage.scenario}`;
    actions.createPage({
      path: path,
      component: require.resolve("./src/templates/katacoda-page.js"),
      context: {
        ...katacodaPage,
        pagePath: path,
        learn: {
          title: doc.frontmatter.title,
          description: doc.frontmatter.description,
        },
      },
    });
  });
};

const processFileNodes = (fileNodes, productVersions, actions) => {
  fileNodes.forEach((node) => {
    const product =
      node.sourceInstanceName === "advocacy_docs"
        ? ""
        : node.sourceInstanceName;
    const version = node.relativePath.split(path.sep)[0];
    const isLatest = product ? productVersions[product][0] === version : false;
    let urlPath = path.join(path.sep, product, node.relativePath);
    if (isLatest) {
      const latestPath = replacePathVersion(urlPath);
      actions.createRedirect({
        fromPath: urlPath,
        toPath: latestPath,
        redirectInBrowser: true,
        isPermanent: false,
        force: true,
      });
      urlPath = latestPath;
    }

    actions.createPage({
      path: urlPath,
      component: require.resolve("./src/templates/file.js"),
      context: {
        nodeId: node.id,
      },
    });
  });
};

exports.sourceNodes = async ({
  actions: { createNode },
  createNodeId,
  createContentDigest,
}) => {
  // create edb-git node
  createNode({
    ...gitData,
    id: createNodeId("edb-git"),
    internal: {
      type: "edbGit",
      contentDigest: createContentDigest(gitData),
    },
  });
};

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions;
  const typeDefs = `
    type Mdx implements Node {
      frontmatter: Frontmatter
    }

    type Frontmatter {
      description: String
      prevNext: Boolean
      iconName: String
      product: String
      platform: String
      originalFilePath: String
      indexCards: TileModes
      editTarget: EditTargets
      legacyRedirects: [String]
      legacyRedirectsGenerated: [String]
      showInteractiveBadge: Boolean
      hideToC: Boolean
      hideVersion: Boolean
      displayBanner: String
      directoryDefaults: DirectoryDefaults
    }

    enum TileModes {
      none
      simple
      full
    }

    enum EditTargets {
      github
      originalFilePath
      none
    }

    type DirectoryDefaults {
      description: String
      prevNext: Boolean
      iconName: String
      product: String
      platform: String
      indexCards: TileModes
      editTarget: EditTargets
      showInteractiveBadge: Boolean
      hideVersion: Boolean
      displayBanner: String
    }
  `;
  createTypes(typeDefs);
};

exports.onPreBootstrap = () => {
  console.log(`
 _____  ____   _____    ____
|   __||    \\ | __  |  |    \\  ___  ___  ___
|   __||  |  || __ -|  |  |  || . ||  _||_ -|
|_____||____/ |_____|  |____/ |___||___||___|

  `);
};

exports.onPostBuild = async ({ reporter, pathPrefix }) => {
  realFs.copyFileSync(
    path.join(__dirname, "/netlify.toml"),
    path.join(__dirname, "/public/netlify.toml"),
  );

  const originalRedirects = await readFile("public/_redirects");

  // rewrite legacy redirects to exclude the /docs prefix
  const prefixRE = new RegExp(`^${pathPrefix}/edb-docs/`);
  let rewrittenRedirects = originalRedirects
    .split("\n")
    .map((line) => line.replace(prefixRE, "/edb-docs/"))
    .join("\n");

  if (rewrittenRedirects.length === originalRedirects.length) {
    reporter.warn("no legacy redirects were rewritten, did something change?");
  }

  await writeFile(
    "public/_redirects",
    `${rewrittenRedirects}

# Catch-all legacy redirects
/edb-docs/d/edb-backup-and-recovery-tool/*      /docs/bart/latest/ 301
/edb-docs/d/edb-postgres-enterprise-manager/*   /docs/pem/latest/ 301
/edb-docs/d/edb-postgres-advanced-server/*      /docs/epas/latest/ 301
/edb-docs/d/postgresql/*                        /docs/supported-open-source/postgresql/ 301
/edb-docs/d/edb-postgres-failover-manager/*     /docs/efm/latest/ 301
/edb-docs/d/edb-postgres-replication-server/*   /docs/eprs/latest/ 301
/edb-docs/d/pgadmin-4/*                         /docs/supported-open-source/pgadmin/ 301
/edb-docs/d/edb-postgres-language-pack/*        /docs/epas/latest/language_pack/  301
/edb-docs/d/edb-postgres-migration-toolkit/*    /docs/migration_toolkit/latest/ 301
/edb-docs/d/edb-postgres-migration-portal/*     /docs/migration_portal/latest/ 301
/edb-docs/d/edb-postgres-hadoop-data-adapter/*  /docs/hadoop_data_adapter/latest/ 301
/edb-docs/d/jdbc-connector/*                    /docs/jdbc_connector/latest/ 301
/edb-docs/d/edb-postgres-ocl-connector/*        /docs/ocl_connector/latest/ 301
/edb-docs/d/edb-postgres-net-connector/*        /docs/net_connector/latest/ 301
/edb-docs/d/edb-postgres-odbc-connector/*       /docs/odbc_connector/latest/ 301
/edb-docs/p/edb-postgres-advanced-server/*      /docs/epas/latest/ 301
/edb-docs/p/postgresql/*                        /docs/supported-open-source/postgresql/ 301
/edb-docs/p/edb-postgres-replication-server/*   /docs/eprs/latest/ 301
/edb-docs/p/edb-postgres-failover-manager/*     /docs/efm/latest/ 301
/edb-docs/p/pgadmin-4/*                         /docs/supported-open-source/pgadmin/ 301
/edb-docs/p/edb-postgres-migration-toolkit/*    /docs/migration_toolkit/latest/ 301
/edb-docs/p/edb-postgres-hadoop-data-adapter/*  /docs/hadoop_data_adapter/latest/ 301
/edb-docs/p/edb-postgres-language-pack/*        /docs/epas/latest/language_pack/  301
/edb-docs/p/jdbc-connector/*                    /docs/jdbc_connector/latest/ 301
/edb-docs/p/edb-postgres-net-connector/*        /docs/net_connector/latest/ 301
/edb-docs/p/edb-postgres-slony-replication/*    /docs/slony/latest/ 301
/edb-docs/p/pgpool-ii/*                         /docs/pgpool/latest/ 301
/edb-docs/p/edb-postgres-mysql-data-adapter/*   /docs/mysql_data_adapter/latest/ 301
/edb-docs/p/edb-postgres-postgis/*              /docs/postgis/latest/ 301
/edb-docs/p/pgbouncer/*                         /docs/pgbouncer/latest/ 301
/edb-docs/p/edb-postgres-mongodb-data-adapter/* /docs/mongo_data_adapter/latest/ 301
/edb-docs/p/edb-postgres-migration-portal/*     /docs/migration_portal/latest/ 301
/edb-docs/p/edb-postgres-enterprise-manager/*   /docs/pem/latest/ 301
/edb-docs/p/edbplus/*                           /docs/edb_plus/latest/ 301
/edb-docs/p/edb-postgres-odbc-connector/*       /docs/odbc_connector/latest/ 301
/edb-docs/p/edb-postgres-ocl-connector/*        /docs/ocl_connector/latest/ 301
/edb-docs/p/edb-backup-and-recovery-tool/*      /docs/bart/latest/ 301
/edb-docs/*                                     /docs/ 301


# Netlify pathPrefix path rewrite
${pathPrefix}/*  /:splat  200`,
  );
};
