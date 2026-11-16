// 讨论区排序项的唯一数据源。
// 仅供 ListToolbar 的 sortOptions 属性使用；新增排序项只改这里，不要在页面里硬编码数组。
// 顺序固定为：最近更新 → 最多赞 → 热门推荐，hot 必须排最后。
export function getDiscussionSortOptions(t) {
  return [
    { value: 'created_at', label: t('workshop.sortRecent') },
    { value: 'likes', label: t('workshop.sortLikes') },
    { value: 'hot', label: t('workshop.sortHot') },
  ]
}
