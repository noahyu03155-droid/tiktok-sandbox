// Direct Shopify Admin API client. This calls Shopify's own GraphQL Admin API
// with a store-specific access token — NOT the Claude/MCP Shopify connector,
// which only exists inside a live chat session. The deployed app needs its
// own credentials so product search works standalone, without Claude being
// present.
//
// This store's app was created in the newer Shopify "dev dashboard", which
// doesn't expose a simple static Admin API token like classic custom apps
// did. Instead we complete a one-time OAuth install (see
// /api/shopify/oauth/install) and persist the resulting access token in
// data/db.json via setShopifyToken/getShopifyToken. SHOPIFY_ADMIN_ACCESS_TOKEN
// in .env is kept as a fallback for stores where a classic static token IS
// available.

import { getShopifyToken } from "./db";

export interface ShopifyProductSummary {
  id: string;
  title: string;
  handle: string;
  description: string;
  tags: string[];
  productType: string;
  imageUrl: string | null;
}

function getConfig() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = getShopifyToken() || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!domain || !token) {
    throw new Error(
      "Shopify isn't configured — set SHOPIFY_STORE_DOMAIN in .env, then visit /api/shopify/oauth/install once to connect your store."
    );
  }
  return { domain, token };
}

async function shopifyGraphQL(query: string, variables: Record<string, any>) {
  const { domain, token } = getConfig();
  const res = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify API error (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json.data;
}

export async function searchShopifyProducts(query: string, limit = 10): Promise<ShopifyProductSummary[]> {
  const gql = `
    query SearchProducts($query: String, $first: Int!) {
      products(first: $first, query: $query) {
        edges {
          node {
            id
            title
            handle
            description
            tags
            productType
            featuredImage { url }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(gql, { query: query || null, first: limit });
  return (data.products.edges || []).map((e: any) => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    description: e.node.description || "",
    tags: e.node.tags || [],
    productType: e.node.productType || "",
    imageUrl: e.node.featuredImage?.url || null,
  }));
}

export async function getShopifyProduct(id: string): Promise<ShopifyProductSummary | null> {
  const gql = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        description
        tags
        productType
        featuredImage { url }
      }
    }
  `;
  const data = await shopifyGraphQL(gql, { id });
  if (!data.product) return null;
  return {
    id: data.product.id,
    title: data.product.title,
    handle: data.product.handle,
    description: data.product.description || "",
    tags: data.product.tags || [],
    productType: data.product.productType || "",
    imageUrl: data.product.featuredImage?.url || null,
  };
}
