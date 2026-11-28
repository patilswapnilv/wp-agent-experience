<?php
/**
 * Extracts materialized WXR content (`content.wxr`), declarative site state (`wpai-state.json`),
 * and Blueprint-added/modified `wp-content/` files from an isolated WordPress Playground instance.
 *
 * Security invariants (docs/export-security-and-parity.md):
 * - Zero raw `runPHP` code is exported for production replay (T2).
 * - Never exports admin accounts, password hashes, salts, or SQLite drop-ins (T4, T5).
 * - Never follows symbolic links inside `/wordpress/wp-content/` (T3).
 */

$out_dir = isset( $wpai_out_dir ) && is_string( $wpai_out_dir ) ? rtrim( $wpai_out_dir, '/' ) : '/wpai-out';
$presnapshot_path = isset( $wpai_presnapshot_path ) && is_string( $wpai_presnapshot_path )
    ? $wpai_presnapshot_path
    : ( $out_dir . '/pre-snapshot.json' );
$explicit_option_keys = isset( $wpai_explicit_option_keys ) && is_array( $wpai_explicit_option_keys )
    ? $wpai_explicit_option_keys
    : array();
$result_path = $out_dir . '/extract-result.json';
$completed = false;

register_shutdown_function( static function () use ( &$result_path, &$completed ): void {
    if ( $completed ) {
        return;
    }
    $err = error_get_last();
    $fallback = array(
        'ok'    => false,
        'error' => $err
            ? ( $err['message'] . ' in ' . $err['file'] . ':' . $err['line'] )
            : 'Materialized extraction terminated unexpectedly inside Playground.',
    );
    @file_put_contents( $result_path, json_encode( $fallback, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
} );

if ( ! defined( 'ABSPATH' ) && file_exists( '/wordpress/wp-load.php' ) ) {
    require_once '/wordpress/wp-load.php';
}
require_once ABSPATH . 'wp-admin/includes/export.php';
if ( file_exists( ABSPATH . 'wp-admin/includes/plugin.php' ) ) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
}

$pre = array(
    'files'             => array(),
    'posts'             => array(),
    'options'           => array(),
    'active_stylesheet' => '',
);
if ( file_exists( $presnapshot_path ) ) {
    $decoded_pre = json_decode( (string) file_get_contents( $presnapshot_path ), true );
    if ( is_array( $decoded_pre ) ) {
        $pre = array_merge( $pre, $decoded_pre );
    }
}

$show_on_front = (string) get_option( 'show_on_front', 'posts' );
$front_id      = (int) get_option( 'page_on_front', 0 );
$posts_id      = (int) get_option( 'page_for_posts', 0 );

// Remove untouched default WordPress install boilerplate (e.g. "Hello world!", "Sample Page",
// "Privacy Policy") so `content.wxr` only exports content created or modified by the Blueprint.
$default_boilerplate_slugs = array( 'hello-world', 'sample-page', 'privacy-policy' );
if ( is_array( $pre['posts'] ) ) {
    foreach ( $pre['posts'] as $pid_str => $info ) {
        $pid = (int) $pid_str;
        if ( $pid <= 0 || $pid === $front_id || $pid === $posts_id ) {
            continue;
        }
        $p = get_post( $pid );
        if ( ! $p ) {
            continue;
        }
        $slug = (string) $p->post_name;
        if ( ! in_array( $slug, $default_boilerplate_slugs, true ) ) {
            continue;
        }
        $cur_hash = sha1(
            (string) $p->post_type . '|' .
            (string) $p->post_status . '|' .
            (string) $p->post_name . '|' .
            (string) $p->post_title . '|' .
            (string) $p->post_content
        );
        if ( isset( $info['hash'] ) && $info['hash'] === $cur_hash ) {
            wp_delete_post( $pid, true );
        }
    }
}

// Export materialized content to WXR
ob_start();
export_wp();
$wxr = (string) ob_get_clean();
file_put_contents( $out_dir . '/content.wxr', $wxr );

// Resolve front-page and posts-page references by published page slug (survives ID remapping on import)
$page_on_front_slug  = null;
$page_for_posts_slug = null;
if ( $show_on_front === 'page' && $front_id > 0 ) {
    $fp = get_post( $front_id );
    if ( $fp && $fp->post_type === 'page' && $fp->post_status === 'publish' && $fp->post_name !== '' ) {
        $page_on_front_slug = (string) $fp->post_name;
    }
}
if ( $posts_id > 0 ) {
    $pp = get_post( $posts_id );
    if ( $pp && $pp->post_type === 'page' && $pp->post_status === 'publish' && $pp->post_name !== '' ) {
        $page_for_posts_slug = (string) $pp->post_name;
    }
}

// Collect allowlisted & Blueprint-declared options
$always_options = array(
    'blogname',
    'blogdescription',
    'permalink_structure',
    'default_comment_status',
    'default_ping_status',
    'show_on_front',
);
$options_out = array();
foreach ( $always_options as $opt_key ) {
    $val = get_option( $opt_key, null );
    if ( $val !== null && $val !== false ) {
        $options_out[ $opt_key ] = $val;
    }
}

if ( is_array( $pre['options'] ) ) {
    foreach ( $pre['options'] as $opt_key => $before_val ) {
        $now_val = get_option( (string) $opt_key, null );
        if ( $now_val !== $before_val && $now_val !== null && $now_val !== false ) {
            $options_out[ (string) $opt_key ] = $now_val;
        }
    }
}

global $wpdb;
if ( isset( $wpdb ) && is_object( $wpdb ) ) {
    $wpai_rows = $wpdb->get_col(
        "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'wpai\\_%'"
    );
    if ( is_array( $wpai_rows ) ) {
        foreach ( $wpai_rows as $opt_key ) {
            if ( is_string( $opt_key ) && $opt_key !== '' ) {
                $options_out[ $opt_key ] = get_option( $opt_key );
            }
        }
    }
}

foreach ( $explicit_option_keys as $opt_key ) {
    if ( ! is_string( $opt_key ) || $opt_key === '' ) {
        continue;
    }
    $val = get_option( $opt_key, '__WPAI_UNSET__' );
    if ( $val !== '__WPAI_UNSET__' ) {
        $options_out[ $opt_key ] = $val;
    }
}

// Non-admin editorial users (never export administrator accounts or password hashes)
$users_out = array();
$all_users = get_users();
foreach ( $all_users as $u ) {
    if ( ! ( $u instanceof WP_User ) ) {
        $u = get_userdata( (int) $u->ID );
    }
    if ( ! $u || (int) $u->ID === 1 ) {
        continue;
    }
    $roles = array_values( (array) $u->roles );
    if ( in_array( 'administrator', $roles, true ) || empty( $roles ) ) {
        continue;
    }
    $primary_role = (string) $roles[0];
    $users_out[] = array(
        'user_login'   => (string) $u->user_login,
        'user_email'   => (string) $u->user_email,
        'display_name' => (string) $u->display_name,
        'role'         => $primary_role,
    );
}

// Local media attachments & featured-image (`_thumbnail_id`) mappings
$attachments_out = array();
$att_posts = get_posts( array(
    'post_type'   => 'attachment',
    'post_status' => 'any',
    'numberposts' => -1,
) );

// Map attachment ID -> posts using it as _thumbnail_id
$featured_map = array();
$content_posts = get_posts( array(
    'post_type'   => 'any',
    'post_status' => 'publish',
    'numberposts' => -1,
) );
foreach ( $content_posts as $cp ) {
    $thumb_id = (int) get_post_meta( (int) $cp->ID, '_thumbnail_id', true );
    if ( $thumb_id > 0 && $cp->post_name !== '' ) {
        if ( ! isset( $featured_map[ $thumb_id ] ) ) {
            $featured_map[ $thumb_id ] = array();
        }
        $featured_map[ $thumb_id ][] = array(
            'post_type' => (string) $cp->post_type,
            'post_name' => (string) $cp->post_name,
        );
    }
}

foreach ( $att_posts as $att ) {
    $rel_upload = (string) get_post_meta( (int) $att->ID, '_wp_attached_file', true );
    if ( $rel_upload === '' || str_contains( $rel_upload, '..' ) ) {
        continue;
    }
    $rel_wp_content = 'uploads/' . ltrim( $rel_upload, '/' );
    if ( ! is_file( '/wordpress/wp-content/' . $rel_wp_content ) ) {
        continue;
    }
    $attachments_out[] = array(
        'slug'         => (string) $att->post_name,
        'title'        => (string) $att->post_title,
        'alt'          => (string) get_post_meta( (int) $att->ID, '_wp_attachment_image_alt', true ),
        'file'         => 'wp-content/' . $rel_wp_content,
        'featured_for' => $featured_map[ (int) $att->ID ] ?? array(),
    );
}

// Detect custom non-core DB tables created by runPHP or plugins
$core_tables = array(
    'commentmeta',
    'comments',
    'links',
    'options',
    'postmeta',
    'posts',
    'term_relationships',
    'term_taxonomy',
    'termmeta',
    'terms',
    'usermeta',
    'users',
);
$custom_tables = array();
if ( isset( $wpdb ) && is_object( $wpdb ) ) {
    $prefix = (string) $wpdb->prefix;
    $sqlite_tables = @$wpdb->get_col( "SELECT name FROM sqlite_master WHERE type='table'" );
    $table_names = is_array( $sqlite_tables ) && ! empty( $sqlite_tables )
        ? $sqlite_tables
        : @$wpdb->get_col( 'SHOW TABLES' );
    if ( is_array( $table_names ) ) {
        foreach ( $table_names as $tbl ) {
            $tbl_str = (string) $tbl;
            if ( str_starts_with( $tbl_str, '_wp_sqlite' ) || $tbl_str === 'sqlite_sequence' ) {
                continue;
            }
            if ( $prefix !== '' && str_starts_with( $tbl_str, $prefix ) ) {
                $bare = substr( $tbl_str, strlen( $prefix ) );
                if ( ! in_array( $bare, $core_tables, true ) ) {
                    $custom_tables[] = $tbl_str;
                }
            }
        }
    }
}

// Copy newly created or modified files from /wordpress/wp-content/ into /wpai-out/wp-content/
$pre_files    = is_array( $pre['files'] ) ? $pre['files'] : array();
$copied_files = array();
$symlinks     = array();
$wp_content   = '/wordpress/wp-content';
$dst_root     = $out_dir . '/wp-content';

$copy_diff = static function ( string $dir, string $rel_dir ) use (
    &$copy_diff,
    &$copied_files,
    &$symlinks,
    $pre_files,
    $dst_root
): void {
    $entries = @scandir( $dir );
    if ( ! is_array( $entries ) ) {
        return;
    }
    foreach ( $entries as $entry ) {
        if ( $entry === '.' || $entry === '..' ) {
            continue;
        }
        $rel = $rel_dir === '' ? $entry : ( $rel_dir . '/' . $entry );
        // Never export Playground's SQLite database directory, drop-ins, or internal 0-* mu-plugins
        if (
            $rel === 'database' ||
            str_starts_with( $rel, 'database/' ) ||
            $rel === 'db.php' ||
            $rel === 'object-cache.php' ||
            $rel === 'advanced-cache.php' ||
            str_starts_with( $rel, 'mu-plugins/0-' ) ||
            str_starts_with( $rel, 'plugins/sqlite-database-integration' )
        ) {
            continue;
        }
        $full = $dir . '/' . $entry;
        if ( is_link( $full ) ) {
            $symlinks[] = 'wp-content/' . $rel;
            continue;
        }
        if ( is_dir( $full ) ) {
            $copy_diff( $full, $rel );
        } elseif ( is_file( $full ) ) {
            $hash = @hash_file( 'sha256', $full );
            if ( isset( $pre_files[ $rel ] ) && $pre_files[ $rel ] === $hash ) {
                continue;
            }
            $target = $dst_root . '/' . $rel;
            $parent = dirname( $target );
            if ( ! is_dir( $parent ) ) {
                mkdir( $parent, 0775, true );
            }
            if ( copy( $full, $target ) ) {
                $copied_files[] = $rel;
            }
        }
    }
};

if ( is_dir( $wp_content ) ) {
    $copy_diff( $wp_content, '' );
}

$theme       = wp_get_theme();
$stylesheet  = (string) $theme->get_stylesheet();
$raw_plugins = array_values( (array) get_option( 'active_plugins', array() ) );
$active_plugins = array();
foreach ( $raw_plugins as $pl ) {
    $pl_str = (string) $pl;
    if ( $pl_str === '' || str_starts_with( $pl_str, 'sqlite-database-integration' ) ) {
        continue;
    }
    $active_plugins[] = $pl_str;
}

$origin_url = (string) get_option( 'home', '' );
if ( $origin_url === '' ) {
    $origin_url = (string) get_option( 'siteurl', '' );
}

$state = array(
    'schema_version'      => '1.0',
    'wordpress_version'   => (string) get_bloginfo( 'version' ),
    'origin_url'          => $origin_url,
    'options'             => $options_out,
    'page_on_front_slug'  => $page_on_front_slug,
    'page_for_posts_slug' => $page_for_posts_slug,
    'active_theme'        => array(
        'stylesheet' => $stylesheet,
        'changed'    => ( $stylesheet !== '' && $stylesheet !== (string) $pre['active_stylesheet'] ),
    ),
    'active_plugins'      => $active_plugins,
    'users'               => $users_out,
    'attachments'         => $attachments_out,
    'custom_tables'       => $custom_tables,
);

file_put_contents(
    $out_dir . '/wpai-state.json',
    json_encode( $state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n"
);

$php_err   = error_get_last();
$fatal_msk = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR;
$has_fatal = is_array( $php_err ) && ( ( $php_err['type'] & $fatal_msk ) !== 0 );

$extract_result = array(
    'ok'            => ! $has_fatal,
    'wxr_bytes'     => strlen( $wxr ),
    'copied_files'  => $copied_files,
    'symlinks'      => $symlinks,
    'custom_tables' => $custom_tables,
    'error'         => $has_fatal ? ( $php_err['message'] . ' in ' . $php_err['file'] . ':' . $php_err['line'] ) : null,
);

file_put_contents(
    $result_path,
    json_encode( $extract_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n"
);
$completed = true;
