<?php
/**
 * Standalone, environment-agnostic WordPress verification probe for WPAI.
 *
 * Runs identically inside:
 * 1. WordPress Playground WASM (`wpai verify`, via inline `$wpai_inline_spec_b64` + `$wpai_report_path`).
 * 2. Real MySQL/MariaDB WordPress (`wp eval-file verify-probe.php <verify.json>` or `wpai verify-target`).
 */

$wpai_target_report_path = isset( $wpai_report_path ) && is_string( $wpai_report_path ) && $wpai_report_path !== ''
    ? $wpai_report_path
    : ( getenv( 'WPAI_REPORT_PATH' ) ? (string) getenv( 'WPAI_REPORT_PATH' ) : '' );
$wpai_written = false;

if ( $wpai_target_report_path !== '' ) {
    register_shutdown_function( function () use ( &$wpai_target_report_path, &$wpai_written ) {
        if ( $wpai_written ) {
            return;
        }
        $err = error_get_last();
        $fallback = array(
            'ok' => false,
            'wordpress_loaded' => defined( 'ABSPATH' ),
            'wordpress_version' => function_exists( 'get_bloginfo' ) ? get_bloginfo( 'version' ) : null,
            'php_version' => PHP_VERSION,
            'blogname' => function_exists( 'get_option' ) ? get_option( 'blogname' ) : null,
            'active_theme' => null,
            'active_plugins' => array(),
            'mu_plugins' => array(),
            'abilities_api' => class_exists( 'WP_Ability' ),
            'registered_abilities_count' => 0,
            'counts' => array(
                'pages' => 0,
                'posts' => 0,
                'post_types' => array(),
                'categories' => 0,
                'users' => 0,
            ),
            'rest_api' => array(
                'types_status' => null,
                'routes' => array(),
            ),
            'php_last_error' => $err,
            'checks' => array(
                array(
                    'name' => 'php_shutdown',
                    'passed' => false,
                    'detail' => $err ? ( $err['message'] . ' in ' . $err['file'] . ':' . $err['line'] ) : 'Verification script terminated unexpectedly',
                ),
            ),
        );
        @file_put_contents( $wpai_target_report_path, json_encode( $fallback, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
    } );
}

if ( ! defined( 'ABSPATH' ) ) {
    $wpai_wp_load_candidates = array();
    if ( getenv( 'WPAI_WP_LOAD' ) ) {
        $wpai_wp_load_candidates[] = (string) getenv( 'WPAI_WP_LOAD' );
    }
    $wpai_wp_load_candidates[] = '/wordpress/wp-load.php';
    $wpai_wp_load_candidates[] = getcwd() . '/wp-load.php';
    foreach ( $wpai_wp_load_candidates as $wpai_candidate ) {
        if ( is_string( $wpai_candidate ) && $wpai_candidate !== '' && file_exists( $wpai_candidate ) ) {
            require_once $wpai_candidate;
            break;
        }
    }
}

$spec = array();
if ( isset( $wpai_inline_spec_b64 ) && is_string( $wpai_inline_spec_b64 ) && $wpai_inline_spec_b64 !== '' ) {
    $decoded = json_decode( (string) base64_decode( $wpai_inline_spec_b64 ), true );
    if ( is_array( $decoded ) ) {
        $spec = $decoded;
    }
} elseif ( getenv( 'WPAI_VERIFY_SPEC_B64' ) ) {
    $decoded = json_decode( (string) base64_decode( (string) getenv( 'WPAI_VERIFY_SPEC_B64' ) ), true );
    if ( is_array( $decoded ) ) {
        $spec = $decoded;
    }
} else {
    $spec_file = '';
    if ( isset( $args ) && is_array( $args ) && isset( $args[0] ) && is_string( $args[0] ) ) {
        $spec_file = $args[0];
    } elseif ( getenv( 'WPAI_VERIFY_SPEC_PATH' ) ) {
        $spec_file = (string) getenv( 'WPAI_VERIFY_SPEC_PATH' );
    } elseif ( isset( $argv ) && is_array( $argv ) && isset( $argv[1] ) && is_string( $argv[1] ) ) {
        $spec_file = $argv[1];
    }
    if ( $spec_file !== '' && file_exists( $spec_file ) ) {
        $decoded = json_decode( (string) file_get_contents( $spec_file ), true );
        if ( is_array( $decoded ) ) {
            $spec = $decoded;
        }
    }
}

$checks = array();
$add_check = function ( $name, $passed, $detail ) use ( &$checks ) {
    $checks[] = array(
        'name' => (string) $name,
        'passed' => (bool) $passed,
        'detail' => (string) $detail,
    );
};

$wp_loaded = defined( 'ABSPATH' ) && function_exists( 'get_bloginfo' );
$wp_version = $wp_loaded ? (string) get_bloginfo( 'version' ) : null;
$php_version = PHP_VERSION;
$add_check( 'wordpress_loaded', $wp_loaded, $wp_loaded ? "WordPress {$wp_version} on PHP {$php_version}" : 'WordPress failed to bootstrap' );

$blogname = $wp_loaded ? (string) get_option( 'blogname', '' ) : null;
$active_theme = null;
$active_plugins = array();
$mu_plugins = array();
$abilities_api = false;
$registered_abilities_count = 0;
$counts = array(
    'pages' => 0,
    'posts' => 0,
    'post_types' => array(),
    'categories' => 0,
    'users' => 0,
);
$front_page = array(
    'show_on_front' => null,
    'page_on_front' => 0,
    'page_on_front_slug' => null,
    'page_for_posts' => 0,
    'page_for_posts_slug' => null,
);
$rest_api = array(
    'types_status' => null,
    'routes' => array(),
);

if ( $wp_loaded ) {
    if ( file_exists( ABSPATH . 'wp-admin/includes/plugin.php' ) ) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }

    $theme = wp_get_theme();
    $active_theme = array(
        'stylesheet' => (string) $theme->get_stylesheet(),
        'name' => (string) $theme->get( 'Name' ),
    );

    $active_plugins = array_values( (array) get_option( 'active_plugins', array() ) );
    if ( function_exists( 'get_mu_plugins' ) ) {
        $mu_plugins = array_keys( get_mu_plugins() );
    }

    $front_page['show_on_front'] = (string) get_option( 'show_on_front', 'posts' );
    $front_id = (int) get_option( 'page_on_front', 0 );
    $posts_id = (int) get_option( 'page_for_posts', 0 );
    $front_page['page_on_front'] = $front_id;
    $front_page['page_for_posts'] = $posts_id;
    if ( $front_id > 0 ) {
        $fp_post = get_post( $front_id );
        if ( $fp_post && $fp_post->post_type === 'page' && $fp_post->post_status === 'publish' ) {
            $front_page['page_on_front_slug'] = (string) $fp_post->post_name;
        }
    }
    if ( $posts_id > 0 ) {
        $pp_post = get_post( $posts_id );
        if ( $pp_post && $pp_post->post_type === 'page' && $pp_post->post_status === 'publish' ) {
            $front_page['page_for_posts_slug'] = (string) $pp_post->post_name;
        }
    }

    if ( ! empty( $spec['required_mu_plugins'] ) && is_array( $spec['required_mu_plugins'] ) ) {
        foreach ( $spec['required_mu_plugins'] as $req_mu ) {
            $mu_name = (string) $req_mu;
            $has_mu = in_array( $mu_name, $mu_plugins, true );
            $add_check(
                "required_mu_plugin:{$mu_name}",
                $has_mu,
                $has_mu ? "MU-plugin '{$mu_name}' is loaded" : "Missing required MU-plugin '{$mu_name}'"
            );
        }
    }

    // Abilities API (WordPress 6.9+)
    $abilities_api = class_exists( 'WP_Ability' );
    $registered_ability_names = array();
    if ( $abilities_api ) {
        try {
            if ( function_exists( 'wp_get_abilities' ) ) {
                $all_abilities = wp_get_abilities();
                if ( is_array( $all_abilities ) ) {
                    $registered_abilities_count = count( $all_abilities );
                    foreach ( $all_abilities as $ab_key => $ab_obj ) {
                        if ( is_string( $ab_key ) && $ab_key !== '' ) {
                            $registered_ability_names[ $ab_key ] = true;
                        }
                        if ( is_object( $ab_obj ) && method_exists( $ab_obj, 'get_name' ) ) {
                            $registered_ability_names[ (string) $ab_obj->get_name() ] = true;
                        }
                    }
                }
            } elseif ( class_exists( 'WP_Abilities_Registry' ) && method_exists( 'WP_Abilities_Registry', 'get_instance' ) ) {
                $reg = WP_Abilities_Registry::get_instance();
                if ( $reg && method_exists( $reg, 'get_all_registered' ) ) {
                    $all_reg = $reg->get_all_registered();
                    if ( is_array( $all_reg ) ) {
                        $registered_abilities_count = count( $all_reg );
                        foreach ( $all_reg as $ab_key => $ab_obj ) {
                            if ( is_string( $ab_key ) && $ab_key !== '' ) {
                                $registered_ability_names[ $ab_key ] = true;
                            }
                            if ( is_object( $ab_obj ) && method_exists( $ab_obj, 'get_name' ) ) {
                                $registered_ability_names[ (string) $ab_obj->get_name() ] = true;
                            }
                        }
                    }
                }
            }
        } catch ( \Throwable $e ) {
            $registered_abilities_count = 0;
        }
    }

    if ( ! empty( $spec['require_abilities_api'] ) ) {
        $add_check(
            'abilities_api_available',
            $abilities_api,
            $abilities_api
                ? "WP_Ability available ({$registered_abilities_count} registered abilities)"
                : 'WP_Ability class not found (requires WordPress 6.9+)'
        );
    }

    if ( ! empty( $spec['required_abilities'] ) && is_array( $spec['required_abilities'] ) ) {
        foreach ( $spec['required_abilities'] as $req_ab ) {
            $ab_name = (string) $req_ab;
            $has_ab = $abilities_api && (
                isset( $registered_ability_names[ $ab_name ] ) ||
                ( function_exists( 'wp_has_ability' ) && wp_has_ability( $ab_name ) )
            );
            $add_check(
                "required_ability:{$ab_name}",
                $has_ab,
                $has_ab ? "Ability '{$ab_name}' is registered" : "Missing required ability '{$ab_name}'"
            );
        }
    }

    // Content counts
    $page_counts = wp_count_posts( 'page' );
    $post_counts = wp_count_posts( 'post' );
    $counts['pages'] = isset( $page_counts->publish ) ? (int) $page_counts->publish : 0;
    $counts['posts'] = isset( $post_counts->publish ) ? (int) $post_counts->publish : 0;

    $all_post_types = get_post_types( array(), 'names' );
    foreach ( $all_post_types as $pt ) {
        $c = wp_count_posts( $pt );
        $pub = isset( $c->publish ) ? (int) $c->publish : 0;
        if ( $pub > 0 || ! in_array( $pt, array( 'revision', 'nav_menu_item', 'custom_css', 'customize_changeset', 'oembed_cache', 'user_request', 'wp_block', 'wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face' ), true ) ) {
            $counts['post_types'][ $pt ] = $pub;
        }
    }

    $cats = get_terms( array( 'taxonomy' => 'category', 'hide_empty' => false ) );
    $counts['categories'] = ( ! is_wp_error( $cats ) && is_array( $cats ) ) ? count( $cats ) : 0;

    $user_counts = count_users();
    $counts['users'] = isset( $user_counts['total_users'] ) ? (int) $user_counts['total_users'] : 0;

    // expected_blogname
    if ( isset( $spec['expected_blogname'] ) && is_string( $spec['expected_blogname'] ) && $spec['expected_blogname'] !== '' ) {
        $expected = $spec['expected_blogname'];
        $matched = ( $blogname === $expected );
        $add_check(
            'expected_blogname',
            $matched,
            $matched ? "blogname matches '{$expected}'" : "Expected blogname '{$expected}', got '{$blogname}'"
        );
    }

    // required_front_page_slug (optional front-page parity check)
    if ( isset( $spec['required_front_page_slug'] ) && is_string( $spec['required_front_page_slug'] ) && $spec['required_front_page_slug'] !== '' ) {
        $expected_fp = strtolower( trim( $spec['required_front_page_slug'] ) );
        $actual_fp = is_string( $front_page['page_on_front_slug'] ) ? strtolower( $front_page['page_on_front_slug'] ) : '';
        $fp_ok = ( $front_page['show_on_front'] === 'page' && $actual_fp === $expected_fp );
        $add_check(
            'required_front_page_slug',
            $fp_ok,
            $fp_ok
                ? "Static front page is '{$expected_fp}' (ID {$front_page['page_on_front']})"
                : "Expected static front page '{$expected_fp}', got show_on_front='{$front_page['show_on_front']}', slug='{$actual_fp}'"
        );
    }

    // required_pages (match by slug or title, case-insensitive)
    if ( ! empty( $spec['required_pages'] ) && is_array( $spec['required_pages'] ) ) {
        $published_pages = get_posts( array(
            'post_type' => 'page',
            'post_status' => 'publish',
            'numberposts' => -1,
        ) );
        $slugs = array();
        $titles = array();
        foreach ( $published_pages as $p ) {
            $slugs[ strtolower( (string) $p->post_name ) ] = true;
            $titles[ strtolower( trim( (string) $p->post_title ) ) ] = true;
        }
        foreach ( $spec['required_pages'] as $req_page ) {
            $needle = strtolower( trim( (string) $req_page ) );
            $found = isset( $slugs[ $needle ] ) || isset( $titles[ $needle ] );
            $add_check(
                "required_page:{$req_page}",
                $found,
                $found ? "Published page '{$req_page}' exists" : "Missing required published page '{$req_page}'"
            );
        }
    }

    // required_posts_min (numeric post count or post_type => min map; fails closed on invalid shapes)
    if ( isset( $spec['required_posts_min'] ) ) {
        if ( is_numeric( $spec['required_posts_min'] ) ) {
            $min = (int) $spec['required_posts_min'];
            $ok_posts = $counts['posts'] >= $min;
            $add_check(
                'required_posts_min',
                $ok_posts,
                "Published posts: {$counts['posts']} (minimum required: {$min})"
            );
        } elseif ( is_array( $spec['required_posts_min'] ) ) {
            if ( empty( $spec['required_posts_min'] ) ) {
                $add_check(
                    'required_posts_min',
                    false,
                    'Invalid required_posts_min: post-type minimum map must not be empty'
                );
            }
            foreach ( $spec['required_posts_min'] as $pt_key => $pt_min ) {
                if ( ! is_string( $pt_key ) || $pt_key === '' || ! is_numeric( $pt_min ) ) {
                    $label = is_string( $pt_key ) && $pt_key !== '' ? $pt_key : (string) $pt_key;
                    $add_check(
                        "required_posts_min:{$label}",
                        false,
                        "Invalid required_posts_min entry for '{$label}' (expected post_type => numeric minimum)"
                    );
                    continue;
                }
                $min_pt = (int) $pt_min;
                if ( isset( $counts['post_types'][ $pt_key ] ) ) {
                    $actual_pt = (int) $counts['post_types'][ $pt_key ];
                } elseif ( post_type_exists( $pt_key ) ) {
                    $c_pt = wp_count_posts( $pt_key );
                    $actual_pt = isset( $c_pt->publish ) ? (int) $c_pt->publish : 0;
                } else {
                    $actual_pt = 0;
                }
                $ok_pt = $actual_pt >= $min_pt;
                $add_check(
                    "required_posts_min:{$pt_key}",
                    $ok_pt,
                    "Published '{$pt_key}': {$actual_pt} (minimum required: {$min_pt})"
                );
            }
        } else {
            $add_check(
                'required_posts_min',
                false,
                'Invalid required_posts_min value (expected number or post_type => count object)'
            );
        }
    }

    // required_post_types
    if ( ! empty( $spec['required_post_types'] ) && is_array( $spec['required_post_types'] ) ) {
        foreach ( $spec['required_post_types'] as $req_pt ) {
            $pt_name = (string) $req_pt;
            $exists = post_type_exists( $pt_name );
            $add_check(
                "required_post_type:{$pt_name}",
                $exists,
                $exists ? "Post type '{$pt_name}' is registered" : "Missing required post type '{$pt_name}'"
            );
        }
    }

    // required_categories
    if ( ! empty( $spec['required_categories'] ) && is_array( $spec['required_categories'] ) ) {
        $cat_slugs = array();
        $cat_names = array();
        if ( ! is_wp_error( $cats ) && is_array( $cats ) ) {
            foreach ( $cats as $c ) {
                $cat_slugs[ strtolower( (string) $c->slug ) ] = true;
                $cat_names[ strtolower( trim( (string) $c->name ) ) ] = true;
            }
        }
        foreach ( $spec['required_categories'] as $req_cat ) {
            $needle = strtolower( trim( (string) $req_cat ) );
            $found = isset( $cat_slugs[ $needle ] ) || isset( $cat_names[ $needle ] );
            $add_check(
                "required_category:{$req_cat}",
                $found,
                $found ? "Category '{$req_cat}' exists" : "Missing required category '{$req_cat}'"
            );
        }
    }

    // required_users_min
    if ( isset( $spec['required_users_min'] ) && is_numeric( $spec['required_users_min'] ) ) {
        $min_u = (int) $spec['required_users_min'];
        $ok_u = $counts['users'] >= $min_u;
        $add_check(
            'required_users_min',
            $ok_u,
            "Total users: {$counts['users']} (minimum required: {$min_u})"
        );
    }

    // required_options
    if ( ! empty( $spec['required_options'] ) && is_array( $spec['required_options'] ) ) {
        foreach ( $spec['required_options'] as $opt_key => $opt_expected ) {
            $actual = get_option( (string) $opt_key, '__WPAI_MISSING__' );
            if ( $opt_expected === null ) {
                $ok_opt = ( $actual !== '__WPAI_MISSING__' && $actual !== '' && $actual !== false );
                $detail = $ok_opt ? "Option '{$opt_key}' is set" : "Option '{$opt_key}' is missing or empty";
            } else {
                $ok_opt = ( $actual !== '__WPAI_MISSING__' && (string) $actual === (string) $opt_expected );
                $detail = $ok_opt
                    ? "Option '{$opt_key}' matches expected value"
                    : "Option '{$opt_key}' expected '" . (string) $opt_expected . "', got '" . ( is_scalar( $actual ) ? (string) $actual : gettype( $actual ) ) . "'";
            }
            $add_check( "required_option:{$opt_key}", $ok_opt, $detail );
        }
    }

    // REST API internal dispatch check
    $types_req = new WP_REST_Request( 'GET', '/wp/v2/types' );
    $types_res = rest_do_request( $types_req );
    $types_status = $types_res ? (int) $types_res->get_status() : 0;
    $rest_api['types_status'] = $types_status;
    $add_check(
        'rest_api_types_200',
        $types_status === 200,
        "GET /wp/v2/types returned HTTP {$types_status}"
    );

    if ( ! empty( $spec['required_rest_routes'] ) && is_array( $spec['required_rest_routes'] ) ) {
        foreach ( $spec['required_rest_routes'] as $route ) {
            $route_str = (string) $route;
            $req = new WP_REST_Request( 'GET', $route_str );
            $res = rest_do_request( $req );
            $status = $res ? (int) $res->get_status() : 0;
            $rest_api['routes'][ $route_str ] = $status;
            $add_check(
                "rest_route:{$route_str}",
                $status === 200,
                "GET {$route_str} returned HTTP {$status}"
            );
        }
    }
}

$php_last_error = error_get_last();
$fatal_mask = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR;
$has_fatal = is_array( $php_last_error ) && ( ( $php_last_error['type'] & $fatal_mask ) !== 0 );
$add_check(
    'no_php_errors',
    ! $has_fatal,
    $has_fatal
        ? ( 'PHP error: ' . $php_last_error['message'] . ' in ' . $php_last_error['file'] . ':' . $php_last_error['line'] )
        : ( $php_last_error ? 'No fatal PHP errors (last non-fatal notice captured)' : 'No PHP errors' )
);

$all_passed = true;
foreach ( $checks as $c ) {
    if ( ! $c['passed'] ) {
        $all_passed = false;
        break;
    }
}

$report = array(
    'ok' => $all_passed,
    'wordpress_loaded' => $wp_loaded,
    'wordpress_version' => $wp_version,
    'php_version' => $php_version,
    'blogname' => $blogname,
    'active_theme' => $active_theme,
    'active_plugins' => $active_plugins,
    'mu_plugins' => $mu_plugins,
    'abilities_api' => $abilities_api,
    'registered_abilities_count' => $registered_abilities_count,
    'counts' => $counts,
    'front_page' => $front_page,
    'rest_api' => $rest_api,
    'php_last_error' => $php_last_error,
    'checks' => $checks,
);

$json_out = json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
if ( $wpai_target_report_path !== '' ) {
    file_put_contents( $wpai_target_report_path, $json_out );
    $wpai_written = true;
} else {
    fwrite( STDOUT, $json_out . "\n" );
    if ( ! $all_passed ) {
        exit( 1 );
    }
}
