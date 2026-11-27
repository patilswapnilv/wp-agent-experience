import fs from 'node:fs';
import path from 'node:path';
import { findBlueprintPresetDir } from './paths.js';
import type { Blueprint, PresetName, VerifySpec } from './types.js';
import { PRESET_NAMES } from './types.js';

export interface PresetTemplate {
  preset: PresetName;
  defaultName: string;
  blueprint: Blueprint;
  verify: VerifySpec;
  readme: string;
}

export interface InitOptions {
  preset: PresetName;
  dir: string;
  name?: string;
  wp?: string;
  php?: string;
}

export interface InitResult {
  preset: PresetName;
  dir: string;
  source: 'repo-blueprints' | 'built-in';
  name: string;
  files_written: string[];
}

export function isValidPreset(value: string): value is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(value);
}

function buildSmallBusinessTemplate(): PresetTemplate {
  const defaultName = 'Local Business Starter';
  const muPluginCode = `<?php
/**
 * Plugin Name: WPAI Business Essentials
 * Description: Lightweight business hours, inquiry REST endpoint, and WordPress 6.9+ Abilities API site-info registration.
 */
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'wpai/v1', '/site-info', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            return rest_ensure_response( array(
                'site_name' => get_bloginfo( 'name' ),
                'tagline'   => get_bloginfo( 'description' ),
                'hours'     => get_option( 'wpai_business_hours', 'Mon-Fri 08:00-18:00, Sat 09:00-15:00' ),
                'phone'     => get_option( 'wpai_business_phone', '(555) 010-2026' ),
            ) );
        },
    ) );
} );

add_action( 'wp_abilities_api_categories_init', function () {
    if ( function_exists( 'wp_register_ability_category' ) ) {
        wp_register_ability_category( 'wpai', array(
            'label'       => 'WPAI Site',
            'description' => 'WordPress Agent Experience site metadata abilities.',
        ) );
    }
} );

add_action( 'wp_abilities_api_init', function () {
    if ( function_exists( 'wp_register_ability' ) ) {
        wp_register_ability( 'wpai/get-business-info', array(
            'label'               => 'Get Business Info',
            'description'         => 'Returns business name, hours, and contact phone number.',
            'category'            => 'wpai',
            'execute_callback'    => function () {
                return array(
                    'site_name' => get_bloginfo( 'name' ),
                    'hours'     => get_option( 'wpai_business_hours', 'Mon-Fri 08:00-18:00, Sat 09:00-15:00' ),
                    'phone'     => get_option( 'wpai_business_phone', '(555) 010-2026' ),
                );
            },
            'permission_callback' => '__return_true',
            'meta'                => array(
                'annotations' => array( 'readonly' => true ),
            ),
        ) );
    }
} );
`;

  const seedPhp = `<?php
require_once '/wordpress/wp-load.php';

$pages = array(
    'home' => array(
        'title'   => 'Home',
        'content' => '<!-- wp:heading {"level":1} --><h1>Welcome to Our Local Business</h1><!-- /wp:heading --><!-- wp:paragraph --><p>Edit this page visually in the WordPress Block Editor anytime—no code or Git required.</p><!-- /wp:paragraph -->',
    ),
    'services' => array(
        'title'   => 'Services',
        'content' => '<!-- wp:heading --><h2>Our Services &amp; Schedule</h2><!-- /wp:heading --><!-- wp:list --><ul><li>Core Service A — Daily</li><li>Core Service B — By Appointment</li></ul><!-- /wp:list -->',
    ),
    'about' => array(
        'title'   => 'About',
        'content' => '<!-- wp:heading --><h2>About Us</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Locally owned and operated. Update our story, team photos, and announcements directly from WP Admin.</p><!-- /wp:paragraph -->',
    ),
    'contact' => array(
        'title'   => 'Contact',
        'content' => '<!-- wp:heading --><h2>Hours &amp; Contact</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Hours: Mon-Fri 08:00-18:00, Sat 09:00-15:00. Reach us anytime by email or phone.</p><!-- /wp:paragraph -->',
    ),
);

$home_id = 0;
foreach ( $pages as $slug => $spec ) {
    $existing = get_page_by_path( $slug );
    if ( $existing ) {
        $id = $existing->ID;
    } else {
        $id = wp_insert_post( array(
            'post_type'    => 'page',
            'post_status'  => 'publish',
            'post_name'    => $slug,
            'post_title'   => $spec['title'],
            'post_content' => $spec['content'],
        ) );
    }
    if ( $slug === 'home' && $id ) {
        $home_id = $id;
    }
}

if ( $home_id ) {
    update_option( 'show_on_front', 'page' );
    update_option( 'page_on_front', $home_id );
}
update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();
`;

  const blueprint: Blueprint = {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: '/',
    meta: {
      title: defaultName,
      author: 'wpai',
      description: 'Owner-editable small business WordPress starter with Block Editor pages, REST endpoint, and Abilities API.',
      categories: ['small-business', 'wpai'],
    },
    preferredVersions: {
      php: '8.3',
      wp: 'latest',
    },
    login: true,
    steps: [
      {
        step: 'setSiteOptions',
        options: {
          blogname: defaultName,
          blogdescription: 'Owner-editable local business site powered by WordPress',
          wpai_business_hours: 'Mon-Fri 08:00-18:00, Sat 09:00-15:00',
          wpai_business_phone: '(555) 010-2026',
        },
      },
      {
        step: 'mkdir',
        path: '/wordpress/wp-content/mu-plugins',
      },
      {
        step: 'writeFile',
        path: '/wordpress/wp-content/mu-plugins/wpai-business-essentials.php',
        data: muPluginCode,
      },
      {
        step: 'runPHP',
        code: seedPhp,
      },
    ],
  };

  const verify: VerifySpec = {
    expected_blogname: defaultName,
    required_pages: ['home', 'services', 'about', 'contact'],
    required_options: {
      show_on_front: 'page',
    },
    required_rest_routes: ['/wp/v2/pages', '/wpai/v1/site-info'],
    require_abilities_api: true,
  };

  const readme = `# ${defaultName}

WordPress starter scaffolded by \`wpai init small-business\`.

## Local Preview (Zero MySQL / Zero Docker)

\`\`\`bash
npm run start
\`\`\`

## Automated Functional Verification

\`\`\`bash
wpai verify .
\`\`\`

## Owner Editing

Log in to \`/wp-admin/\` to edit Home, Services, About, and Contact pages visually in the WordPress Block Editor.
`;

  return { preset: 'small-business', defaultName, blueprint, verify, readme };
}

function buildCommerceTemplate(): PresetTemplate {
  const defaultName = 'WPAI Online Store';
  const muPluginCode = `<?php
/**
 * Plugin Name: WPAI Commerce Starter
 * Description: Lightweight product catalog CPT with SKU, price, stock quantity, weight-based shipping rules, and REST/Abilities integration.
 */
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'init', function () {
    register_post_type( 'wpai_product', array(
        'labels' => array(
            'name'          => 'Products',
            'singular_name' => 'Product',
        ),
        'public'       => true,
        'show_in_rest' => true,
        'supports'     => array( 'title', 'editor', 'custom-fields', 'thumbnail' ),
        'has_archive'  => true,
        'rewrite'      => array( 'slug' => 'products' ),
    ) );

    foreach ( array( 'sku', 'price_usd', 'stock_qty', 'weight_kg' ) as $meta_key ) {
        register_post_meta( 'wpai_product', $meta_key, array(
            'show_in_rest' => true,
            'single'       => true,
            'type'         => 'string',
        ) );
    }
} );

add_action( 'rest_api_init', function () {
    register_rest_route( 'wpai/v1', '/shipping-rates', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            return rest_ensure_response( array(
                'model' => 'weight-based',
                'tiers' => array(
                    array( 'max_kg' => 1.0, 'rate_usd' => 5.00 ),
                    array( 'max_kg' => 5.0, 'rate_usd' => 12.00 ),
                    array( 'max_kg' => 20.0, 'rate_usd' => 25.00 ),
                ),
            ) );
        },
    ) );
} );

add_action( 'wp_abilities_api_categories_init', function () {
    if ( function_exists( 'wp_register_ability_category' ) ) {
        wp_register_ability_category( 'wpai', array(
            'label'       => 'WPAI Store',
            'description' => 'Store catalog and shipping abilities.',
        ) );
    }
} );

add_action( 'wp_abilities_api_init', function () {
    if ( function_exists( 'wp_register_ability' ) ) {
        wp_register_ability( 'wpai/list-products', array(
            'label'               => 'List Catalog Products',
            'description'         => 'Lists published products with SKU, price, stock quantity, and weight.',
            'category'            => 'wpai',
            'execute_callback'    => function () {
                $items = get_posts( array(
                    'post_type'      => 'wpai_product',
                    'post_status'    => 'publish',
                    'posts_per_page' => 50,
                ) );
                return array_map( function ( $p ) {
                    return array(
                        'id'        => $p->ID,
                        'title'     => $p->post_title,
                        'sku'       => get_post_meta( $p->ID, 'sku', true ),
                        'price_usd' => get_post_meta( $p->ID, 'price_usd', true ),
                        'stock_qty' => get_post_meta( $p->ID, 'stock_qty', true ),
                        'weight_kg' => get_post_meta( $p->ID, 'weight_kg', true ),
                    );
                }, $items );
            },
            'permission_callback' => '__return_true',
            'meta'                => array(
                'annotations' => array( 'readonly' => true ),
            ),
        ) );
    }
} );
`;

  const seedPhp = `<?php
require_once '/wordpress/wp-load.php';

$pages = array(
    'shop' => array(
        'title'   => 'Shop',
        'content' => '<!-- wp:heading {"level":1} --><h1>Storefront</h1><!-- /wp:heading --><!-- wp:paragraph --><p>Browse our catalog below. Manage inventory, pricing, and WooCommerce extensions from WP Admin.</p><!-- /wp:paragraph -->',
    ),
    'cart' => array(
        'title'   => 'Cart & Checkout',
        'content' => '<!-- wp:heading --><h2>Cart &amp; Checkout</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Ready for WooCommerce Cart/Checkout blocks and weight-based shipping rules.</p><!-- /wp:paragraph -->',
    ),
    'shipping-and-returns' => array(
        'title'   => 'Shipping & Returns',
        'content' => '<!-- wp:heading --><h2>Weight-Based Shipping</h2><!-- /wp:heading --><!-- wp:list --><ul><li>Up to 1 kg: $5.00</li><li>1–5 kg: $12.00</li><li>5–20 kg: $25.00</li></ul><!-- /wp:list -->',
    ),
    'contact' => array(
        'title'   => 'Contact',
        'content' => '<!-- wp:heading --><h2>Store Support</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Questions about orders or wholesale stock? Contact our team anytime.</p><!-- /wp:paragraph -->',
    ),
);

$shop_id = 0;
foreach ( $pages as $slug => $spec ) {
    $existing = get_page_by_path( $slug );
    $id = $existing ? $existing->ID : wp_insert_post( array(
        'post_type'    => 'page',
        'post_status'  => 'publish',
        'post_name'    => $slug,
        'post_title'   => $spec['title'],
        'post_content' => $spec['content'],
    ) );
    if ( $slug === 'shop' && $id ) {
        $shop_id = $id;
    }
}

$products = array(
    array( 'slug' => 'starter-item-alpha', 'title' => 'Starter Item Alpha', 'sku' => 'SKU-001', 'price' => '24.00', 'stock' => '45', 'weight' => '0.4' ),
    array( 'slug' => 'starter-item-beta',  'title' => 'Starter Item Beta',  'sku' => 'SKU-002', 'price' => '48.00', 'stock' => '18', 'weight' => '1.2' ),
    array( 'slug' => 'starter-item-gamma', 'title' => 'Starter Item Gamma', 'sku' => 'SKU-003', 'price' => '75.00', 'stock' => '10', 'weight' => '2.5' ),
);

foreach ( $products as $item ) {
    $existing_prod = get_page_by_path( $item['slug'], OBJECT, 'wpai_product' );
    $pid = $existing_prod ? $existing_prod->ID : wp_insert_post( array(
        'post_type'    => 'wpai_product',
        'post_status'  => 'publish',
        'post_name'    => $item['slug'],
        'post_title'   => $item['title'],
        'post_content' => '<!-- wp:paragraph --><p>Editable product description with SKU, stock tracking, and shipping weight.</p><!-- /wp:paragraph -->',
    ) );
    if ( $pid && ! is_wp_error( $pid ) ) {
        update_post_meta( $pid, 'sku', $item['sku'] );
        update_post_meta( $pid, 'price_usd', $item['price'] );
        update_post_meta( $pid, 'stock_qty', $item['stock'] );
        update_post_meta( $pid, 'weight_kg', $item['weight'] );
    }
}

if ( $shop_id ) {
    update_option( 'show_on_front', 'page' );
    update_option( 'page_on_front', $shop_id );
}
update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();
`;

  const blueprint: Blueprint = {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: '/',
    meta: {
      title: defaultName,
      author: 'wpai',
      description: 'Online store WordPress starter with catalog CPT, stock & weight metadata, shipping rules, and WooCommerce upgrade path.',
      categories: ['commerce', 'wpai'],
    },
    preferredVersions: {
      php: '8.3',
      wp: 'latest',
    },
    login: true,
    steps: [
      {
        step: 'setSiteOptions',
        options: {
          blogname: defaultName,
          blogdescription: 'Open-source online store powered by WordPress',
        },
      },
      {
        step: 'mkdir',
        path: '/wordpress/wp-content/mu-plugins',
      },
      {
        step: 'writeFile',
        path: '/wordpress/wp-content/mu-plugins/wpai-commerce-starter.php',
        data: muPluginCode,
      },
      {
        step: 'runPHP',
        code: seedPhp,
      },
    ],
  };

  const verify: VerifySpec = {
    expected_blogname: defaultName,
    required_pages: ['shop', 'cart', 'shipping-and-returns', 'contact'],
    required_post_types: ['wpai_product'],
    required_rest_routes: ['/wp/v2/wpai_product', '/wpai/v1/shipping-rates'],
    require_abilities_api: true,
  };

  const readme = `# ${defaultName}

WordPress commerce starter scaffolded by \`wpai init commerce\`.

## Local Preview (Zero MySQL / Zero Docker)

\`\`\`bash
npm run start
\`\`\`

## Automated Functional Verification

\`\`\`bash
wpai verify .
\`\`\`

## WooCommerce Upgrade Path

Add \`woocommerce\` and \`weight-based-shipping-for-woocommerce\` to \`blueprint.json\` or install them from WP Admin for full checkout and payment gateways.
`;

  return { preset: 'commerce', defaultName, blueprint, verify, readme };
}

function buildPublishingTemplate(): PresetTemplate {
  const defaultName = 'WPAI Community News';
  const seedPhp = `<?php
require_once '/wordpress/wp-load.php';

$categories = array(
    'local-news' => 'Local News',
    'guides'     => 'Guides',
    'opinion'    => 'Opinion',
);

$cat_ids = array();
foreach ( $categories as $slug => $label ) {
    $term = term_exists( $slug, 'category' );
    if ( ! $term ) {
        $term = wp_insert_term( $label, 'category', array( 'slug' => $slug ) );
    }
    if ( ! is_wp_error( $term ) ) {
        $cat_ids[ $slug ] = is_array( $term ) ? (int) $term['term_id'] : (int) $term;
    }
}

$authors = array(
    array( 'login' => 'maya_editor', 'email' => 'maya@example.org', 'name' => 'Maya Lin', 'role' => 'editor' ),
    array( 'login' => 'sam_reporter', 'email' => 'sam@example.org', 'name' => 'Sam Patel', 'role' => 'author' ),
    array( 'login' => 'alex_contrib', 'email' => 'alex@example.org', 'name' => 'Alex Rivera', 'role' => 'contributor' ),
);

$author_ids = array();
foreach ( $authors as $u ) {
    $existing = get_user_by( 'login', $u['login'] );
    if ( $existing ) {
        $uid = $existing->ID;
    } else {
        $uid = wp_insert_user( array(
            'user_login'   => $u['login'],
            'user_pass'    => wp_generate_password( 20, true ),
            'user_email'   => $u['email'],
            'display_name' => $u['name'],
            'role'         => $u['role'],
        ) );
    }
    if ( ! is_wp_error( $uid ) ) {
        $author_ids[ $u['login'] ] = (int) $uid;
    }
}

$pages = array(
    'about' => array(
        'title'   => 'About',
        'content' => '<!-- wp:heading --><h2>About Our Publication</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Independent reporting and stories published using WordPress core editorial workflows.</p><!-- /wp:paragraph -->',
    ),
    'editorial-team' => array(
        'title'   => 'Editorial Team',
        'content' => '<!-- wp:heading --><h2>Meet Our Writers</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Every contributor has their own login, role permissions, and automatic author archive page.</p><!-- /wp:paragraph -->',
    ),
);

foreach ( $pages as $slug => $spec ) {
    if ( ! get_page_by_path( $slug ) ) {
        wp_insert_post( array(
            'post_type'    => 'page',
            'post_status'  => 'publish',
            'post_name'    => $slug,
            'post_title'   => $spec['title'],
            'post_content' => $spec['content'],
        ) );
    }
}

$articles = array(
    array(
        'slug'   => 'town-council-approves-new-community-trail',
        'title'  => 'Town Council Approves New Community Trail',
        'cat'    => 'local-news',
        'author' => $author_ids['maya_editor'] ?? 1,
        'body'   => '<!-- wp:paragraph --><p>Local residents gathered Tuesday evening to celebrate approval of the three-mile walking and cycling loop.</p><!-- /wp:paragraph -->',
    ),
    array(
        'slug'   => 'weekend-farmers-market-guide',
        'title'  => 'Weekend Farmers Market Guide',
        'cat'    => 'guides',
        'author' => $author_ids['sam_reporter'] ?? 1,
        'body'   => '<!-- wp:paragraph --><p>Seasonal produce schedules, parking tips, and bakeries opening early every Saturday morning.</p><!-- /wp:paragraph -->',
    ),
    array(
        'slug'   => 'why-independent-local-reporting-matters',
        'title'  => 'Why Independent Local Reporting Matters',
        'cat'    => 'opinion',
        'author' => $author_ids['maya_editor'] ?? 1,
        'body'   => '<!-- wp:paragraph --><p>Owning our domain, RSS feed, and editorial archive ensures our community stories remain accessible forever.</p><!-- /wp:paragraph -->',
    ),
);

foreach ( $articles as $art ) {
    if ( get_page_by_path( $art['slug'], OBJECT, 'post' ) ) {
        continue;
    }
    wp_insert_post( array(
        'post_type'     => 'post',
        'post_status'   => 'publish',
        'post_name'     => $art['slug'],
        'post_title'    => $art['title'],
        'post_content'  => $art['body'],
        'post_author'   => $art['author'],
        'post_category' => isset( $cat_ids[ $art['cat'] ] ) ? array( $cat_ids[ $art['cat'] ] ) : array(),
    ) );
}

update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();
`;

  const blueprint: Blueprint = {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: '/',
    meta: {
      title: defaultName,
      author: 'wpai',
      description: 'Multi-author blog and local news publication starter using WordPress core Posts, Categories, and Editorial Roles.',
      categories: ['publishing', 'wpai'],
    },
    preferredVersions: {
      php: '8.3',
      wp: 'latest',
    },
    login: true,
    steps: [
      {
        step: 'setSiteOptions',
        options: {
          blogname: defaultName,
          blogdescription: 'Multi-author community blog and newsroom powered by WordPress',
        },
      },
      {
        step: 'runPHP',
        code: seedPhp,
      },
    ],
  };

  const verify: VerifySpec = {
    expected_blogname: defaultName,
    required_pages: ['about', 'editorial-team'],
    required_posts_min: 3,
    required_categories: ['local-news', 'guides', 'opinion'],
    required_users_min: 3,
    required_rest_routes: ['/wp/v2/posts', '/wp/v2/categories', '/wp/v2/users'],
    require_abilities_api: true,
  };

  const readme = `# ${defaultName}

Multi-author WordPress publishing starter scaffolded by \`wpai init publishing\`.

## Local Preview (Zero MySQL / Zero Docker)

\`\`\`bash
npm run start
\`\`\`

## Automated Functional Verification

\`\`\`bash
wpai verify .
\`\`\`

## Editorial Roles Included

- **Administrator** (default Playground admin)
- **Editor** (\`maya_editor\`)
- **Author** (\`sam_reporter\`)
- **Contributor** (\`alex_contrib\`)
`;

  return { preset: 'publishing', defaultName, blueprint, verify, readme };
}

export function getBuiltInPreset(preset: PresetName): PresetTemplate {
  switch (preset) {
    case 'small-business':
      return buildSmallBusinessTemplate();
    case 'commerce':
      return buildCommerceTemplate();
    case 'publishing':
      return buildPublishingTemplate();
    case 'nonprofit':
      return buildNonprofitTemplate();
    case 'course':
      return buildCourseTemplate();
    case 'migration':
      return buildMigrationTemplate();
  }
}

function buildNonprofitTemplate(): PresetTemplate {
  const defaultName = 'Community Nonprofit Starter';
  const muPluginCode = `<?php
/**
 * Plugin Name: WPAI Nonprofit Essentials
 * Description: Events, donation pledges, volunteer signups, REST API endpoints, and WP 6.9+ Abilities API registration.
 */
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'init', function () {
    register_post_type( 'wpai_event', array(
        'labels'       => array( 'name' => 'Events', 'singular_name' => 'Event' ),
        'public'       => true,
        'show_in_rest' => true,
        'supports'     => array( 'title', 'editor', 'excerpt', 'custom-fields' ),
        'has_archive'  => true,
        'rewrite'      => array( 'slug' => 'events' ),
    ) );
    register_post_type( 'wpai_donation', array(
        'labels'       => array( 'name' => 'Donations', 'singular_name' => 'Donation' ),
        'public'       => false,
        'show_ui'      => true,
        'show_in_rest' => false,
        'supports'     => array( 'title', 'custom-fields' ),
    ) );
    register_post_type( 'wpai_volunteer', array(
        'labels'       => array( 'name' => 'Volunteers', 'singular_name' => 'Volunteer' ),
        'public'       => false,
        'show_ui'      => true,
        'show_in_rest' => false,
        'supports'     => array( 'title', 'custom-fields' ),
    ) );
} );

add_action( 'rest_api_init', function () {
    register_rest_route( 'wpai/v1', '/nonprofit-summary', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            $events = wp_count_posts( 'wpai_event' );
            return rest_ensure_response( array(
                'organization'    => get_bloginfo( 'name' ),
                'upcoming_events' => isset( $events->publish ) ? (int) $events->publish : 0,
            ) );
        },
    ) );
} );

add_action( 'wp_abilities_api_categories_init', function () {
    if ( function_exists( 'wp_register_ability_category' ) ) {
        wp_register_ability_category( 'wpai', array(
            'label'       => 'WPAI Nonprofit',
            'description' => 'Nonprofit events, donations, and volunteer abilities.',
        ) );
    }
} );

add_action( 'wp_abilities_api_init', function () {
    if ( function_exists( 'wp_register_ability' ) ) {
        wp_register_ability( 'wpai/get-nonprofit-summary', array(
            'label'               => 'Get Nonprofit Summary',
            'description'         => 'Returns organization name and published event count.',
            'category'            => 'wpai',
            'execute_callback'    => function () {
                $events = wp_count_posts( 'wpai_event' );
                return array(
                    'organization'    => get_bloginfo( 'name' ),
                    'upcoming_events' => isset( $events->publish ) ? (int) $events->publish : 0,
                );
            },
            'permission_callback' => '__return_true',
            'meta'                => array( 'annotations' => array( 'readonly' => true ) ),
        ) );
    }
} );
`;

  const seedPhp = `<?php
require_once '/wordpress/wp-load.php';

$pages = array(
    'home'      => array( 'title' => 'Home', 'content' => '<!-- wp:heading {"level":1} --><h1>Serving Our Community Together</h1><!-- /wp:heading --><!-- wp:paragraph --><p>Edit our mission, events, and impact stories directly in the WordPress Block Editor.</p><!-- /wp:paragraph -->' ),
    'events'    => array( 'title' => 'Events', 'content' => '<!-- wp:heading {"level":1} --><h1>Upcoming Community Events</h1><!-- /wp:heading -->' ),
    'donate'    => array( 'title' => 'Donate', 'content' => '<!-- wp:heading {"level":1} --><h1>Support Our Mission</h1><!-- /wp:heading --><!-- wp:paragraph --><p>Connect GiveWP or Stripe to accept one-time and recurring donations.</p><!-- /wp:paragraph -->' ),
    'volunteer' => array( 'title' => 'Volunteer', 'content' => '<!-- wp:heading {"level":1} --><h1>Volunteer Signup</h1><!-- /wp:heading -->' ),
);

$home_id = 0;
foreach ( $pages as $slug => $cfg ) {
    $existing = get_page_by_path( $slug );
    if ( ! $existing ) {
        $id = wp_insert_post( array(
            'post_type'    => 'page',
            'post_status'  => 'publish',
            'post_name'    => $slug,
            'post_title'   => $cfg['title'],
            'post_content' => $cfg['content'],
        ) );
    } else {
        $id = $existing->ID;
    }
    if ( $slug === 'home' ) {
        $home_id = (int) $id;
    }
}

if ( $home_id > 0 ) {
    update_option( 'show_on_front', 'page' );
    update_option( 'page_on_front', $home_id );
}

$events = array(
    array( 'slug' => 'community-park-cleanup', 'title' => 'Community Park Cleanup', 'date' => '2026-12-06' ),
    array( 'slug' => 'annual-winter-fundraiser', 'title' => 'Annual Winter Fundraiser', 'date' => '2026-12-18' ),
);
foreach ( $events as $ev ) {
    $existing_ev = get_page_by_path( $ev['slug'], OBJECT, 'wpai_event' );
    $id = $existing_ev ? $existing_ev->ID : wp_insert_post( array(
        'post_type'    => 'wpai_event',
        'post_status'  => 'publish',
        'post_name'    => $ev['slug'],
        'post_title'   => $ev['title'],
        'post_content' => '<!-- wp:paragraph --><p>Join our volunteers for ' . esc_html( $ev['title'] ) . '.</p><!-- /wp:paragraph -->',
    ) );
    if ( $id && ! is_wp_error( $id ) ) {
        update_post_meta( $id, '_wpai_event_date', $ev['date'] );
    }
}
flush_rewrite_rules();
`;

  return {
    preset: 'nonprofit',
    defaultName,
    blueprint: {
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      landingPage: '/',
      meta: {
        title: defaultName,
        author: 'WPAI',
        description: 'Reproducible WordPress nonprofit starter with Events, Donations, Volunteers, REST API, and Abilities API.',
      },
      preferredVersions: { php: '8.3', wp: 'latest' },
      login: true,
      steps: [
        {
          step: 'setSiteOptions',
          options: {
            blogname: defaultName,
            blogdescription: 'Community events, donations, and volunteer coordination.',
            permalink_structure: '/%postname%/',
          },
        },
        { step: 'mkdir', path: '/wordpress/wp-content/mu-plugins' },
        { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/wpai-nonprofit.php', data: muPluginCode },
        { step: 'runPHP', code: seedPhp },
      ],
    },
    verify: {
      expected_blogname: defaultName,
      required_pages: ['home', 'events', 'donate', 'volunteer'],
      required_post_types: ['wpai_event'],
      required_rest_routes: ['/wp/v2/types', '/wpai/v1/nonprofit-summary'],
      require_abilities_api: true,
    },
    readme: `# ${defaultName}\n\nScaffolded by \`wpai init nonprofit\`.\n\n## Quick Start\n\n\`\`\`bash\nnpm start\nwpai verify .\nwpai export . --out ./dist-wp\n\`\`\`\n`,
  };
}

function buildCourseTemplate(): PresetTemplate {
  const defaultName = 'Online Course Studio';
  const muPluginCode = `<?php
/**
 * Plugin Name: WPAI Course Essentials
 * Description: Courses & video lessons CPTs, enrollment REST endpoint, and WP 6.9+ Abilities API registration.
 */
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'init', function () {
    register_post_type( 'wpai_course', array(
        'labels'       => array( 'name' => 'Courses', 'singular_name' => 'Course' ),
        'public'       => true,
        'show_in_rest' => true,
        'supports'     => array( 'title', 'editor', 'excerpt', 'custom-fields' ),
        'has_archive'  => true,
        'rewrite'      => array( 'slug' => 'courses' ),
    ) );
    register_post_type( 'wpai_lesson', array(
        'labels'       => array( 'name' => 'Lessons', 'singular_name' => 'Lesson' ),
        'public'       => true,
        'show_in_rest' => true,
        'supports'     => array( 'title', 'editor', 'custom-fields' ),
        'rewrite'      => array( 'slug' => 'lessons' ),
    ) );
} );

add_action( 'rest_api_init', function () {
    register_rest_route( 'wpai/v1', '/courses', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            $courses = get_posts( array( 'post_type' => 'wpai_course', 'post_status' => 'publish', 'numberposts' => 20 ) );
            $items = array();
            foreach ( $courses as $c ) {
                $items[] = array(
                    'id'    => $c->ID,
                    'title' => $c->post_title,
                    'price' => (float) get_post_meta( $c->ID, '_wpai_course_price', true ),
                );
            }
            return rest_ensure_response( array( 'courses' => $items, 'count' => count( $items ) ) );
        },
    ) );
} );

add_action( 'wp_abilities_api_categories_init', function () {
    if ( function_exists( 'wp_register_ability_category' ) ) {
        wp_register_ability_category( 'wpai', array(
            'label'       => 'WPAI Courses',
            'description' => 'Course catalog and lesson abilities.',
        ) );
    }
} );

add_action( 'wp_abilities_api_init', function () {
    if ( function_exists( 'wp_register_ability' ) ) {
        wp_register_ability( 'wpai/list-courses', array(
            'label'               => 'List Courses',
            'description'         => 'Returns published courses and prices.',
            'category'            => 'wpai',
            'execute_callback'    => function () {
                $counts = wp_count_posts( 'wpai_course' );
                return array( 'courses_published' => isset( $counts->publish ) ? (int) $counts->publish : 0 );
            },
            'permission_callback' => '__return_true',
            'meta'                => array( 'annotations' => array( 'readonly' => true ) ),
        ) );
    }
} );
`;

  const seedPhp = `<?php
require_once '/wordpress/wp-load.php';

$pages = array(
    'home'       => array( 'title' => 'Home', 'content' => '<!-- wp:heading {"level":1} --><h1>Learn Online at Your Own Pace</h1><!-- /wp:heading -->' ),
    'courses'    => array( 'title' => 'Courses', 'content' => '<!-- wp:heading {"level":1} --><h1>Course Catalog</h1><!-- /wp:heading -->' ),
    'my-courses' => array( 'title' => 'My Courses', 'content' => '<!-- wp:heading {"level":1} --><h1>Student Dashboard</h1><!-- /wp:heading -->' ),
    'contact'    => array( 'title' => 'Contact', 'content' => '<!-- wp:heading {"level":1} --><h1>Instructor Contact</h1><!-- /wp:heading -->' ),
);

$home_id = 0;
foreach ( $pages as $slug => $cfg ) {
    $existing = get_page_by_path( $slug );
    if ( ! $existing ) {
        $id = wp_insert_post( array(
            'post_type'    => 'page',
            'post_status'  => 'publish',
            'post_name'    => $slug,
            'post_title'   => $cfg['title'],
            'post_content' => $cfg['content'],
        ) );
    } else {
        $id = $existing->ID;
    }
    if ( $slug === 'home' ) {
        $home_id = (int) $id;
    }
}

if ( $home_id > 0 ) {
    update_option( 'show_on_front', 'page' );
    update_option( 'page_on_front', $home_id );
}

$existing_course = get_page_by_path( 'foundations-video-workshop', OBJECT, 'wpai_course' );
$cid = $existing_course ? $existing_course->ID : wp_insert_post( array(
    'post_type'    => 'wpai_course',
    'post_status'  => 'publish',
    'post_name'    => 'foundations-video-workshop',
    'post_title'   => 'Foundations Video Workshop',
    'post_content' => '<!-- wp:paragraph --><p>Step-by-step recorded video lessons with downloadable notes.</p><!-- /wp:paragraph -->',
) );
if ( $cid && ! is_wp_error( $cid ) ) {
    update_post_meta( $cid, '_wpai_course_price', '79.00' );
}
if ( ! get_page_by_path( 'lesson-1-free-preview-setup', OBJECT, 'wpai_lesson' ) ) {
    wp_insert_post( array(
        'post_type'    => 'wpai_lesson',
        'post_status'  => 'publish',
        'post_name'    => 'lesson-1-free-preview-setup',
        'post_title'   => 'Lesson 1: Free Preview & Setup',
        'post_content' => '<!-- wp:paragraph --><p>Embed Vimeo, Bunny Stream, or Mux video blocks directly in the Block Editor.</p><!-- /wp:paragraph -->',
    ) );
}
flush_rewrite_rules();
`;

  return {
    preset: 'course',
    defaultName,
    blueprint: {
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      landingPage: '/',
      meta: {
        title: defaultName,
        author: 'WPAI',
        description: 'Reproducible WordPress online course & video lesson starter with Abilities API.',
      },
      preferredVersions: { php: '8.3', wp: 'latest' },
      login: true,
      steps: [
        {
          step: 'setSiteOptions',
          options: {
            blogname: defaultName,
            blogdescription: 'Self-owned online video courses without SaaS lock-in.',
            permalink_structure: '/%postname%/',
          },
        },
        { step: 'mkdir', path: '/wordpress/wp-content/mu-plugins' },
        { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/wpai-course.php', data: muPluginCode },
        { step: 'runPHP', code: seedPhp },
      ],
    },
    verify: {
      expected_blogname: defaultName,
      required_pages: ['home', 'courses', 'my-courses', 'contact'],
      required_post_types: ['wpai_course', 'wpai_lesson'],
      required_rest_routes: ['/wp/v2/types', '/wpai/v1/courses'],
      require_abilities_api: true,
    },
    readme: `# ${defaultName}\n\nScaffolded by \`wpai init course\`.\n\n## Quick Start\n\n\`\`\`bash\nnpm start\nwpai verify .\nwpai export . --out ./dist-wp\n\`\`\`\n`,
  };
}

function buildMigrationTemplate(): PresetTemplate {
  const defaultName = 'Migrated Editable Site';
  const muPluginCode = `<?php
/**
 * Plugin Name: WPAI Migration Essentials
 * Description: Legacy .html -> clean URL 301 redirect support, REST status route, and WP 6.9+ Abilities API registration.
 */
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'template_redirect', function () {
    $uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
    $path = (string) wp_parse_url( $uri, PHP_URL_PATH );
    if ( preg_match( '#^/([a-z0-9_-]+)\\.html$#i', $path, $m ) ) {
        $slug = strtolower( $m[1] );
        $target = ( $slug === 'index' ) ? home_url( '/' ) : home_url( '/' . $slug . '/' );
        wp_safe_redirect( $target, 301 );
        exit;
    }
} );

add_action( 'rest_api_init', function () {
    register_rest_route( 'wpai/v1', '/migration-status', array(
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            $pages = wp_count_posts( 'page' );
            return rest_ensure_response( array(
                'site_name'         => get_bloginfo( 'name' ),
                'editable_pages'    => isset( $pages->publish ) ? (int) $pages->publish : 0,
                'legacy_redirects'  => true,
            ) );
        },
    ) );
} );

add_action( 'wp_abilities_api_categories_init', function () {
    if ( function_exists( 'wp_register_ability_category' ) ) {
        wp_register_ability_category( 'wpai', array(
            'label'       => 'WPAI Migration',
            'description' => 'Static-to-WordPress migration metadata abilities.',
        ) );
    }
} );

add_action( 'wp_abilities_api_init', function () {
    if ( function_exists( 'wp_register_ability' ) ) {
        wp_register_ability( 'wpai/get-migration-status', array(
            'label'               => 'Get Migration Status',
            'description'         => 'Returns editable page count and legacy .html redirect status.',
            'category'            => 'wpai',
            'execute_callback'    => function () {
                $pages = wp_count_posts( 'page' );
                return array(
                    'editable_pages'   => isset( $pages->publish ) ? (int) $pages->publish : 0,
                    'legacy_redirects' => true,
                );
            },
            'permission_callback' => '__return_true',
            'meta'                => array( 'annotations' => array( 'readonly' => true ) ),
        ) );
    }
} );
`;

  const seedPhp = `<?php
require_once '/wordpress/wp-load.php';

$pages = array(
    'home'    => array( 'title' => 'Home', 'content' => '<!-- wp:heading {"level":1} --><h1>Now Visually Editable in WordPress</h1><!-- /wp:heading --><!-- wp:paragraph --><p>All migrated sections can be edited directly in the Block Editor without touching HTML files.</p><!-- /wp:paragraph -->' ),
    'about'   => array( 'title' => 'About', 'content' => '<!-- wp:heading {"level":1} --><h1>About Us</h1><!-- /wp:heading -->' ),
    'contact' => array( 'title' => 'Contact', 'content' => '<!-- wp:heading {"level":1} --><h1>Contact</h1><!-- /wp:heading -->' ),
);

$home_id = 0;
foreach ( $pages as $slug => $cfg ) {
    $existing = get_page_by_path( $slug );
    if ( ! $existing ) {
        $id = wp_insert_post( array(
            'post_type'    => 'page',
            'post_status'  => 'publish',
            'post_name'    => $slug,
            'post_title'   => $cfg['title'],
            'post_content' => $cfg['content'],
        ) );
    } else {
        $id = $existing->ID;
    }
    if ( $slug === 'home' ) {
        $home_id = (int) $id;
    }
}

if ( $home_id > 0 ) {
    update_option( 'show_on_front', 'page' );
    update_option( 'page_on_front', $home_id );
}
flush_rewrite_rules();
`;

  return {
    preset: 'migration',
    defaultName,
    blueprint: {
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      landingPage: '/',
      meta: {
        title: defaultName,
        author: 'WPAI',
        description: 'Reproducible static-HTML-to-WordPress migration starter with .html 301 redirects and Abilities API.',
      },
      preferredVersions: { php: '8.3', wp: 'latest' },
      login: true,
      steps: [
        {
          step: 'setSiteOptions',
          options: {
            blogname: defaultName,
            blogdescription: 'Migrated from static HTML to WordPress Block Editor.',
            permalink_structure: '/%postname%/',
          },
        },
        { step: 'mkdir', path: '/wordpress/wp-content/mu-plugins' },
        { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/wpai-migration.php', data: muPluginCode },
        { step: 'runPHP', code: seedPhp },
      ],
    },
    verify: {
      expected_blogname: defaultName,
      required_pages: ['home', 'about', 'contact'],
      required_rest_routes: ['/wp/v2/types', '/wpai/v1/migration-status'],
      require_abilities_api: true,
    },
    readme: `# ${defaultName}\n\nScaffolded by \`wpai init migration\`.\n\n## Quick Start\n\n\`\`\`bash\nnpm start\nwpai verify .\nwpai export . --out ./dist-wp\n\`\`\`\n`,
  };
}

function copyDirRecursive(srcDir: string, destDir: string, written: string[]): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, written);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      written.push(destPath);
    }
  }
}

function applyBlueprintCustomizations(
  blueprint: Blueprint,
  options: { name?: string; wp?: string; php?: string }
): void {
  if (options.wp || options.php) {
    blueprint.preferredVersions = {
      ...(blueprint.preferredVersions ?? {}),
      ...(options.php ? { php: options.php } : {}),
      ...(options.wp ? { wp: options.wp } : {}),
    };
  }

  if (options.name) {
    if (blueprint.meta && typeof blueprint.meta === 'object') {
      blueprint.meta.title = options.name;
    }

    let updatedStep = false;
    if (Array.isArray(blueprint.steps)) {
      for (const step of blueprint.steps) {
        if (
          step &&
          step.step === 'setSiteOptions' &&
          step.options &&
          typeof step.options === 'object' &&
          !Array.isArray(step.options)
        ) {
          (step.options as Record<string, unknown>).blogname = options.name;
          updatedStep = true;
          break;
        }
      }
    }

    if (blueprint.siteOptions && typeof blueprint.siteOptions === 'object') {
      blueprint.siteOptions.blogname = options.name;
      updatedStep = true;
    }

    if (!updatedStep) {
      blueprint.steps = [
        { step: 'setSiteOptions', options: { blogname: options.name } },
        ...(blueprint.steps ?? []),
      ];
    }
  }
}

function slugifyPackageName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'wpai-site';
}

export function initProject(options: InitOptions): InitResult {
  const targetDir = path.resolve(options.dir);
  fs.mkdirSync(targetDir, { recursive: true });

  const builtIn = getBuiltInPreset(options.preset);
  const repoPresetDir = findBlueprintPresetDir(options.preset);
  const written: string[] = [];

  let source: 'repo-blueprints' | 'built-in';
  let blueprint: Blueprint;
  let verifySpec: VerifySpec;
  let siteName = options.name ?? builtIn.defaultName;

  if (repoPresetDir) {
    source = 'repo-blueprints';
    copyDirRecursive(repoPresetDir, targetDir, written);

    const bpPath = path.join(targetDir, 'blueprint.json');
    blueprint = JSON.parse(fs.readFileSync(bpPath, 'utf8')) as Blueprint;
    applyBlueprintCustomizations(blueprint, {
      name: options.name,
      wp: options.wp,
      php: options.php,
    });
    fs.writeFileSync(bpPath, `${JSON.stringify(blueprint, null, 2)}\n`, 'utf8');

    const verifyPath = path.join(targetDir, 'verify.json');
    if (fs.existsSync(verifyPath)) {
      verifySpec = JSON.parse(fs.readFileSync(verifyPath, 'utf8')) as VerifySpec;
      if (options.name) {
        verifySpec.expected_blogname = options.name;
      } else if (verifySpec.expected_blogname) {
        siteName = verifySpec.expected_blogname;
      }
      fs.writeFileSync(verifyPath, `${JSON.stringify(verifySpec, null, 2)}\n`, 'utf8');
    } else {
      verifySpec = {
        ...builtIn.verify,
        ...(options.name ? { expected_blogname: options.name } : {}),
      };
      fs.writeFileSync(verifyPath, `${JSON.stringify(verifySpec, null, 2)}\n`, 'utf8');
      written.push(verifyPath);
    }
  } else {
    source = 'built-in';
    blueprint = structuredClone(builtIn.blueprint);
    verifySpec = structuredClone(builtIn.verify);
    applyBlueprintCustomizations(blueprint, {
      name: options.name,
      wp: options.wp,
      php: options.php,
    });
    if (options.name) {
      verifySpec.expected_blogname = options.name;
    }

    const bpPath = path.join(targetDir, 'blueprint.json');
    fs.writeFileSync(bpPath, `${JSON.stringify(blueprint, null, 2)}\n`, 'utf8');
    written.push(bpPath);

    const verifyPath = path.join(targetDir, 'verify.json');
    fs.writeFileSync(verifyPath, `${JSON.stringify(verifySpec, null, 2)}\n`, 'utf8');
    written.push(verifyPath);
  }

  // Write package.json with @wp-playground/cli scripts
  const pkgPath = path.join(targetDir, 'package.json');
  const pkgJson = {
    name: slugifyPackageName(siteName),
    version: '0.1.0',
    private: true,
    description: `${siteName} — WordPress Playground project scaffolded by wpai (${options.preset}).`,
    scripts: {
      start: 'npx -y @wp-playground/cli@3.1.66 server --blueprint=./blueprint.json --blueprint-may-read-adjacent-files --port=9400',
      'run-blueprint': 'npx -y @wp-playground/cli@3.1.66 run-blueprint --blueprint=./blueprint.json --blueprint-may-read-adjacent-files',
      verify: 'wpai verify .',
    },
  };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');
  if (!written.includes(pkgPath)) written.push(pkgPath);

  // Write README.md if not already provided by repo preset
  const readmePath = path.join(targetDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const readmeText = options.name
      ? builtIn.readme.replace(builtIn.defaultName, options.name)
      : builtIn.readme;
    fs.writeFileSync(readmePath, readmeText, 'utf8');
    written.push(readmePath);
  }

  return {
    preset: options.preset,
    dir: targetDir,
    source,
    name: siteName,
    files_written: written.map((f) => path.relative(targetDir, f) || path.basename(f)),
  };
}
