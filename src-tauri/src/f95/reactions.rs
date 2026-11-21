use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GivenPage {
    posts: Vec<String>,
    threads: Vec<String>,
    unlinked: Vec<String>,
    more: bool,
    key: String,
}

#[derive(serde::Serialize)]
pub struct GivenLikes {
    posts: HashSet<String>,
    openings: BTreeMap<String, String>,
    complete: bool,
    unresolved: usize,
}

#[tauri::command]
pub async fn f95_given_likes(window: WebviewWindow) -> Result<GivenLikes, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let browser = signed_in_browser(&window)?;
    // A refresh must not take a page away from someone reading the original forum.
    if browser.is_visible().map_err(|_| "givenRead")? {
        return Err("givenBrowserOpen");
    }

    let target = Url::parse(&format!("{ORIGIN}/account/reactions?f95ac_given=1")).unwrap();
    mark_previous_page(&browser)
        .await
        .map_err(|_| "givenRead")?;
    browser.navigate(target).map_err(|_| "givenRead")?;

    let inspect = include_str!("given-likes.js");
    let mut last_key = None;
    let mut batches = HashSet::new();
    let mut posts = HashSet::new();
    let mut candidates = HashSet::new();
    let mut unlinked = HashSet::new();
    let complete = loop {
        let mut page = wait_for_browser(&browser, inspect, |page: &GivenPage| {
            last_key.as_ref() != Some(&page.key)
        })
        .await;
        if page.is_none() && last_key.is_some() && !STOP_SCAN.load(Ordering::Relaxed) {
            let _ = browser.eval("window.__sfmmmGivenLikes?.loadMore()");
            page = wait_for_browser(&browser, inspect, |page: &GivenPage| {
                last_key.as_ref() != Some(&page.key)
            })
            .await;
        }
        let Some(page) = page else {
            if last_key.is_none() {
                return Err("givenRead");
            }
            break false;
        };
        posts.extend(page.posts);
        candidates.extend(page.threads);
        unlinked.extend(page.unlinked);
        if !page.more {
            break true;
        }
        if batches.len() >= 200 || !batches.insert(page.key.clone()) {
            break false;
        }
        last_key = Some(page.key);
        if browser.eval("window.__sfmmmGivenLikes.loadMore()").is_err() {
            break false;
        }
        // The load-more control can disappear while F95 is appending the next batch.
        tokio::time::sleep(Duration::from_millis(400)).await;
    };

    // Replies are keyed by post ID. Some topic cards have not cached their first
    // post yet. Resolve those only for topics referenced in the reaction list.
    let mut openings = BTreeMap::new();
    let mut unresolved = 0;
    if !posts.is_empty() {
        let mut unknown = BTreeMap::new();
        let mut known_targets = Vec::new();
        {
            let db = cache_db(&window)?;
            for thread in read_threads(&window)? {
                let (url, id) = parse_thread(&thread.url)?;
                let cache = read_scan_data(&db, &id)?;
                for entry in cache.pages.values().flat_map(|page| &page.entries) {
                    unlinked.remove(&entry.id);
                }
                let cached = cache
                    .opening
                    .iter()
                    .chain(
                        cache
                            .pages
                            .get(&1)
                            .into_iter()
                            .flat_map(|page| &page.entries),
                    )
                    .find(|post| post.first);
                if let Some(post) = cached {
                    unlinked.remove(&post.id);
                    if posts.contains(&post.id) {
                        openings.insert(thread.url, post.id.clone());
                    }
                } else {
                    if candidates.contains(&id) {
                        known_targets.push((url.to_string(), None::<String>));
                    }
                    unknown.insert(id, thread.url);
                }
            }
        }
        if !unknown.is_empty() {
            known_targets.extend(
                unlinked
                    .into_iter()
                    .map(|post| (format!("{ORIGIN}/posts/{post}/"), Some(post))),
            );
        }
        for batch in known_targets.chunks(8) {
            if unknown.is_empty() {
                break;
            }
            let job = REACTION_JOB.fetch_add(1, Ordering::Relaxed);
            let targets = serde_json::to_string(batch).map_err(|_| "givenRead")?;
            let resolve = include_str!("given-openings.js").trim();
            let script = format!("({resolve})({job}, {targets})");
            if let Some(result) =
                wait_for_browser(&browser, &script, |_: &OpeningMatches| true).await
            {
                unresolved += result.errors;
                for (thread, post) in result.matches {
                    if posts.contains(&post) {
                        if let Some(url) = unknown.remove(&thread) {
                            openings.insert(url, post);
                        }
                    }
                }
            } else {
                unresolved += batch.len();
                break;
            }
        }
    }
    Ok(GivenLikes {
        posts,
        openings,
        complete,
        unresolved,
    })
}

#[derive(serde::Deserialize)]
struct OpeningMatches {
    errors: usize,
    matches: Vec<(String, String)>,
}

#[derive(serde::Deserialize)]
struct ReactionControl {
    id: String,
    liked: bool,
    ready: bool,
}

#[derive(serde::Serialize)]
pub struct PostLike {
    id: String,
    liked: bool,
    likes: Option<usize>,
}

#[tauri::command]
pub async fn f95_set_post_like(
    window: WebviewWindow,
    thread_url: String,
    post_id: Option<String>,
    liked: bool,
) -> Result<PostLike, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let (thread_url, thread) = parse_thread(&thread_url)?;
    let browser = signed_in_browser(&window)?;
    if browser.is_visible().map_err(|_| "reactionWrite")? {
        return Err("givenBrowserOpen");
    }
    let url = if let Some(id) = post_id.as_ref() {
        let id = id
            .parse::<u64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or("reactionWrite")?;
        Url::parse(&format!("{ORIGIN}/posts/{id}/")).map_err(|_| "reactionWrite")?
    } else {
        thread_url.clone()
    };
    mark_previous_page(&browser)
        .await
        .map_err(|_| "reactionWrite")?;
    browser.navigate(url).map_err(|_| "reactionWrite")?;
    let post_arg = serde_json::to_string(&post_id).map_err(|_| "reactionWrite")?;
    let read = include_str!("post-reaction.js");
    let inspect = format!("{read}({thread:?}, {post_arg}, false)");
    let control = wait_for_browser(&browser, &inspect, |state: &ReactionControl| state.ready)
        .await
        .ok_or("reactionWrite")?;
    if control.liked != liked {
        let click = format!("{read}({thread:?}, {post_arg}, true, {liked})");
        browser.eval(&click).map_err(|_| "reactionWrite")?;
        wait_for_browser(&browser, &inspect, |state: &ReactionControl| {
            state.id == control.id && state.liked == liked
        })
        .await
        .ok_or("reactionWrite")?;
    }
    let page = inspect_thread_page(&browser, false, Some(&control.id), |page| {
        page.thread == thread && page.entries.iter().any(|entry| entry.id == control.id)
    })
    .await
    .ok();
    let mut live =
        page.and_then(|page| page.entries.into_iter().find(|post| post.id == control.id));
    if let Some(post) = live.as_mut() {
        // Reuse the existing Like-specific count reader when the bar is ambiguous.
        hydrate_likes(&browser, std::slice::from_mut(post)).await?;
    }
    let likes = live.as_ref().and_then(|entry| entry.likes);
    if let Some(count) = likes {
        let mut cache = read_scan(&window, &thread)?;
        let mut changed = false;
        for entry in cache
            .opening
            .iter_mut()
            .chain(cache.pages.values_mut().flat_map(|page| &mut page.entries))
        {
            if entry.id == control.id {
                entry.likes = Some(count);
                changed = true;
            }
        }
        if changed {
            save_scan(&window, &thread, &cache)?;
        }
        if live.is_some_and(|entry| entry.first) {
            if let Some(mut topic) = read_threads(&window)?
                .into_iter()
                .find(|topic| parse_thread(&topic.url).is_ok_and(|(_, id)| id == thread))
            {
                topic.likes = Some(count);
                save_threads(&window, &[topic])?;
            }
        }
    }
    Ok(PostLike {
        id: control.id,
        liked,
        likes,
    })
}
